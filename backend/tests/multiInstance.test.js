import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const processes = [];
const keyIds = [];
const codes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let instances = [];
let ipCounter = 0;
const runOctet = Math.floor(Math.random() * 250) + 1;

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

const start = (script, env = {}) => {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, RATE_LIMIT_ENABLED: 'true', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.output = () => stderr;
  processes.push(child);
  return child;
};

const startServer = async () => {
  const port = await freePort();
  const child = start('src/server.js', { PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/ping`)).ok) return { base, child };
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Server did not start:\n${child.output()}`);
};

const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });

const freshIp = () => {
  ipCounter += 1;
  return `10.${runOctet}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

const call = async (instance, method, path, { apiKey, body, headers = {}, ip = freshIp() } = {}) => {
  const res = await fetch(`${instance.base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      'X-Forwarded-For': ip,
      ...(body && { 'Content-Type': 'application/json' }),
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (json?.code) codes.add(json.code);
  return { status: res.status, headers: res.headers, body: json };
};

const makeKey = async (instance = instances[0]) => {
  const res = await call(instance, 'POST', '/api/v1/keys', { body: { name: 'multi-instance test' } });
  expect(res.status).toBe(201);
  keyIds.push(res.body.id);
  return res.body.apiKey;
};

const pick = (i) => instances[i % instances.length];

beforeAll(async () => {
  instances = await Promise.all([startServer(), startServer()]);
}, 30_000);

afterAll(async () => {
  await Promise.all(processes.map(stop));
  const limits = await redis.keys(`rl:*:10.${runOctet}.*`);
  if (limits.length > 0) await redis.del(...limits);
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('two API instances sharing one Postgres and one Redis', () => {
  it('really are two separate processes', async () => {
    expect(instances[0].child.pid).not.toBe(instances[1].child.pid);
    expect(instances[0].base).not.toBe(instances[1].base);
  });

  it('never hand out the same short code, even when both create links at once', async () => {
    const keys = await Promise.all(Array.from({ length: 5 }, (_, i) => makeKey(pick(i))));
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        call(pick(i), 'POST', '/api/v1/links', {
          apiKey: keys[i % keys.length],
          body: { url: `https://example.com/multi/${i}` },
        })
      )
    );

    expect(results.every((res) => res.status === 201)).toBe(true);
    const created = results.map((res) => res.body.code);
    expect(new Set(created).size).toBe(100);
    const { rows } = await query('SELECT count(DISTINCT code)::int AS n FROM links WHERE code = ANY($1)', [created]);
    expect(rows[0].n).toBe(100);
  });

  it('share rate limits: five new keys per hour from one IP, across both instances together', async () => {
    const ip = freshIp();
    await redis.del(`rl:keyCreation:${ip}`);
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await call(pick(i), 'POST', '/api/v1/keys', { body: { name: 'shared limit' }, ip });
      if (res.status === 201) keyIds.push(res.body.id);
      statuses.push(res.status);
    }

    expect(statuses.filter((status) => status === 201)).toHaveLength(5);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    await redis.del(`rl:keyCreation:${ip}`);
  });

  it('see a change made on the other instance straight away', async () => {
    const apiKey = await makeKey();
    const created = await call(instances[0], 'POST', '/api/v1/links', { apiKey, body: { url: 'https://example.com/coherent' } });
    const { code } = created.body;

    expect((await call(instances[1], 'GET', `/${code}`)).status).toBe(302);
    expect((await call(instances[1], 'GET', `/${code}`)).headers.get('x-cache')).toBe('HIT');

    expect((await call(instances[0], 'PATCH', `/api/v1/links/${code}`, { apiKey, body: { disabled: true } })).status).toBe(200);
    expect((await call(instances[1], 'GET', `/${code}`)).status).toBe(410);

    expect((await call(instances[1], 'DELETE', `/api/v1/links/${code}`, { apiKey })).status).toBe(204);
    expect((await call(instances[0], 'GET', `/${code}`)).status).toBe(404);
  });

  it('create one link for an Idempotency-Key sent to both instances at once', async () => {
    const apiKey = await makeKey();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(pick(i), 'POST', '/api/v1/links', {
          apiKey,
          body: { url: 'https://example.com/once-only' },
          headers: { 'Idempotency-Key': key },
        })
      )
    );

    const created = results.filter((res) => res.status === 201);
    expect(created.length + results.filter((res) => res.status === 409).length).toBe(10);
    expect(new Set(created.map((res) => res.body.code)).size).toBe(1);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM links l JOIN api_keys k ON k.id = l.api_key_id WHERE k.id = $1`,
      [keyIds.at(-1)]
    );
    expect(rows[0].n).toBe(1);
  });

  it('let exactly one claim win when both instances race for the same alias', async () => {
    const apiKey = await makeKey();
    const alias = `race-${Date.now().toString(36)}`;
    codes.add(alias);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(pick(i), 'POST', '/api/v1/links', { apiKey, body: { url: `https://example.com/${i}`, alias } })
      )
    );

    expect(results.map((res) => res.status).sort()).toEqual([201, ...Array(9).fill(409)]);
  });
});

describe('two click workers sharing one stream', () => {
  it('record every click exactly once between them', async () => {
    const blocked = async () => Number(/blocked_clients:(\d+)/.exec(await redis.info('clients'))[1]);
    const waitForBlocked = async (count) => {
      for (let i = 0; i < 100 && (await blocked()) < count; i += 1) await sleep(50);
      return blocked();
    };
    const idle = await blocked();
    const workers = [start('src/worker.js'), start('src/worker.js')];
    expect(await waitForBlocked(idle + 2)).toBe(idle + 2);

    const apiKey = await makeKey();
    const created = await call(instances[0], 'POST', '/api/v1/links', { apiKey, body: { url: 'https://example.com/clicked' } });
    const { code } = created.body;
    const { rows: [link] } = await query('SELECT id FROM links WHERE code = $1', [code]);

    for (let wave = 0; wave < 6; wave += 1) {
      const redirects = await Promise.all(Array.from({ length: 10 }, (_, i) => call(pick(i), 'GET', `/${code}`)));
      expect(redirects.every((res) => res.status === 302)).toBe(true);
      await sleep(100);
      await waitForBlocked(idle + 2);
    }

    let clicks = 0;
    for (let i = 0; i < 100 && clicks < 60; i += 1) {
      await sleep(100);
      clicks = (await query('SELECT count(*)::int AS n FROM clicks WHERE link_id = $1', [link.id])).rows[0].n;
    }
    await sleep(500);

    expect((await query('SELECT count(*)::int AS n FROM clicks WHERE link_id = $1', [link.id])).rows[0].n).toBe(60);
    const { rows: [rollup] } = await query('SELECT coalesce(sum(clicks), 0)::int AS n FROM link_stats_hourly WHERE link_id = $1', [link.id]);
    expect(rollup.n).toBe(60);

    const consumers = await redis.xinfo('CONSUMERS', 'clicks', 'click-workers');
    const names = consumers.map((fields) => fields[fields.indexOf('name') + 1]);
    for (const worker of workers) expect(names.some((name) => name.endsWith(`-${worker.pid}`))).toBe(true);

    const stats = await call(instances[1], 'GET', `/api/v1/links/${code}/stats`, { apiKey });
    expect(stats.body.totalClicks).toBe(60);

    await Promise.all(workers.map(stop));
  }, 30_000);
});
