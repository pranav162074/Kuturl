import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { logConnectionHealth } from '../src/config/redisConnection.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = `t${Math.random().toString(36).slice(2, 8)}:`;
const processes = [];
const keyIds = [];

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const startServer = async (env) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  processes.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/ping`)).ok) return base;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Server did not start:\n${stderr}`);
};

const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });

const loadEnv = (overrides) => {
  const env = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "const { default: env } = await import('./src/config/env.js'); console.log(JSON.stringify(env));"],
    { cwd: root, env, encoding: 'utf8' }
  );
};

const renderEnvVars = () => {
  const text = readFileSync(`${repoRoot}render.yaml`, 'utf8');
  const vars = [];
  for (const line of text.split('\n')) {
    const key = line.match(/^\s*- key: (\S+)/);
    if (key) vars.push({ key: key[1] });
    const field = line.match(/^\s+(value|sync|generateValue): (.+)$/);
    if (field && vars.length > 0) vars.at(-1)[field[1]] = field[2].replace(/^"|"$/g, '');
  }
  return { text, vars };
};

afterAll(async () => {
  await Promise.all(processes.map(stop));
  const leftovers = await redis.keys(`${prefix}*`);
  if (leftovers.length > 0) await redis.del(...leftovers);
  if (keyIds.length > 0) await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  await closePool();
  await redis.quit();
});

describe('Redis outage logging', () => {
  const setup = () => {
    const connection = new EventEmitter();
    const lines = [];
    const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => lines.push([level, args.at(-1)])]));
    let clock = 0;
    logConnectionHealth(connection, 'Redis', { log, now: () => clock });
    return { connection, lines, tick: (ms) => (clock += ms) };
  };

  it('logs the first failure, then one reminder a minute, then the recovery', () => {
    const { connection, lines, tick } = setup();
    connection.emit('ready');
    for (let i = 0; i < 30; i += 1) {
      connection.emit('error', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      tick(5_000);
    }
    connection.emit('ready');

    expect(lines).toEqual([
      ['info', 'Redis connected'],
      ['error', 'Redis unavailable'],
      ['warn', 'Redis still unavailable'],
      ['warn', 'Redis still unavailable'],
      ['info', 'Redis reconnected'],
    ]);
  });

  it('does not announce a reconnect for an ordinary second ready', () => {
    const { connection, lines } = setup();
    connection.emit('ready');
    connection.emit('ready');
    expect(lines).toEqual([['info', 'Redis connected']]);
  });
});

describe('configuration on Render', () => {
  it('builds links on the address Render gives the service', () => {
    const result = loadEnv({ PUBLIC_URL: undefined, RENDER_EXTERNAL_URL: 'https://kuturl.onrender.com' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).baseUrl).toBe('https://kuturl.onrender.com');
  });

  it('lets PUBLIC_URL win over the Render address', () => {
    const result = loadEnv({ PUBLIC_URL: 'https://kut.example/', RENDER_EXTERNAL_URL: 'https://kuturl.onrender.com' });
    expect(JSON.parse(result.stdout).baseUrl).toBe('https://kut.example');
  });

  it('refuses a key prefix that could break key names', () => {
    const result = loadEnv({ REDIS_KEY_PREFIX: 'prod links:' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REDIS_KEY_PREFIX');
  });

  it('keeps the background jobs out of the web process unless asked', () => {
    const result = loadEnv({ RUN_WORKER: undefined });
    expect(JSON.parse(result.stdout).runWorker).toBe(false);
  });
});

describe('render.yaml', () => {
  const { text, vars } = renderEnvVars();
  const byKey = Object.fromEntries(vars.map((entry) => [entry.key, entry]));
  const example = readFileSync(`${root}.env.example`, 'utf8');

  it('is a free web service built from the backend folder', () => {
    expect(text).toMatch(/^\s+- type: web$/m);
    expect(text).toMatch(/^\s+plan: free$/m);
    expect(text).toMatch(/^\s+rootDir: backend$/m);
    expect(text).toMatch(/^\s+healthCheckPath: \/ping$/m);
  });

  it('installs from the lockfile and migrates before starting', () => {
    const build = text.match(/^\s+buildCommand: (.+)$/m)[1];
    expect(build).toContain('npm ci');
    expect(build).not.toContain('npm install');
    expect(build).toContain('npm run migrate');
    expect(text).toMatch(/^\s+startCommand: npm start$/m);
  });

  it('runs the worker in the web process with its own key prefix', () => {
    expect(byKey.RUN_WORKER.value).toBe('true');
    expect(byKey.REDIS_KEY_PREFIX.value).toMatch(/^[A-Za-z0-9_:-]{1,32}$/);
    expect(byKey.DEBUG_CLIENT_IP.value).toBe('false');
  });

  it('never holds a connection string or a secret', () => {
    for (const key of ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL']) {
      expect(byKey[key], key).toEqual({ key, sync: 'false' });
    }
    for (const key of ['CODE_SECRET', 'METRICS_TOKEN']) {
      expect(byKey[key], key).toEqual({ key, generateValue: 'true' });
    }
    expect(text).not.toMatch(/postgres(ql)?:\/\/|rediss?:\/\//);
  });

  it('only sets settings the app knows about, with a Node version it supports', () => {
    for (const { key } of vars) {
      if (key === 'NODE_VERSION') continue;
      expect(example, key).toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
    }
    const engines = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).engines.node;
    expect(Number(byKey.NODE_VERSION.value)).toBeGreaterThanOrEqual(Number(engines.match(/\d+/)[0]));
  });
});

describe('one process with the worker inside, behind a key prefix', () => {
  let base;

  beforeAll(async () => {
    base = await startServer({ RUN_WORKER: 'true', REDIS_KEY_PREFIX: prefix, DEBUG_CLIENT_IP: 'true', TRUST_PROXY: '2' });
  }, 30_000);

  const call = async (method, path, { apiKey, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body && { 'Content-Type': 'application/json' }),
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
        ...headers,
      },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };

  it('records clicks without a separate worker, and keeps every key under its prefix', async () => {
    const key = await call('POST', '/api/v1/keys', { body: { name: 'deploy test' } });
    keyIds.push(key.body.id);
    const apiKey = key.body.apiKey;
    const { code } = (await call('POST', '/api/v1/links', { apiKey, body: { url: 'https://example.com/deployed' } })).body;

    for (let i = 0; i < 3; i += 1) expect((await call('GET', `/${code}`)).status).toBe(302);

    let total = 0;
    for (let i = 0; i < 100 && total < 3; i += 1) {
      await sleep(100);
      total = (await call('GET', `/api/v1/links/${code}/stats`, { apiKey })).body.totalClicks;
    }
    expect(total).toBe(3);

    expect(await redis.exists(`${prefix}link:${code}`)).toBe(1);
    expect(await redis.exists(`link:${code}`)).toBe(0);
    expect(await redis.exists(`${prefix}clicks`)).toBe(1);
    const groups = await redis.xinfo('GROUPS', `${prefix}clicks`);
    expect(groups.length).toBe(1);
  });

  it('prefixes its pub/sub channels too', async () => {
    const channels = await redis.pubsub('CHANNELS', `${prefix}*`);
    expect(channels.sort()).toEqual([`${prefix}links:created`, `${prefix}webhooks:nudge`]);
  });

  it('shows which address it takes for the client, for setting TRUST_PROXY', async () => {
    const res = await call('GET', '/debug/client-ip', { headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ip: '203.0.113.9',
      ips: ['203.0.113.9', '198.51.100.7'],
      forwardedFor: '203.0.113.9, 198.51.100.7',
      trustProxy: 2,
    });
  });
});

describe('the client address check, when switched off', () => {
  it('is not there', async () => {
    const { default: request } = await import('supertest');
    const { default: app } = await import('../src/app.js');
    const res = await request(app).get('/debug/client-ip');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
