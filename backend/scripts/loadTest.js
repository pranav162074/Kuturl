import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';
import pg from 'pg';
import Redis from 'ioredis';
import { summarize, problemsWith, toMarkdown } from './load/stats.js';

const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres', 'redis']);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PREFIX = 'load:';
const METRICS_TOKEN = 'load-test-metrics-token';
const root = fileURLToPath(new URL('..', import.meta.url));

const durationSeconds = Number(process.env.LOAD_DURATION || 10);
const connections = Number(process.env.LOAD_CONNECTIONS || 50);
const resultsPath = process.env.LOAD_RESULTS || 'load-results.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const key of ['DATABASE_URL', 'REDIS_URL']) {
  let host;
  try {
    host = new URL(process.env[key]).hostname;
  } catch {
    host = null;
  }
  if (!SAFE_HOSTS.has(host)) {
    console.error(`Refusing to run: ${key} must point at a local or CI service. The load test writes data and floods the server.`);
    process.exit(1);
  }
}

const randomCode = () => Array.from({ length: 7 }, () => BASE62[Math.floor(Math.random() * 62)]).join('');
const pick = (list) => list[Math.floor(Math.random() * list.length)];

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

const startServer = async ({ bloom }) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: String(port),
      PUBLIC_URL: base,
      CODE_SECRET: process.env.CODE_SECRET || 'load-test-code-secret-not-for-production',
      RATE_LIMIT_ENABLED: 'false',
      RUN_WORKER: 'true',
      REDIS_KEY_PREFIX: PREFIX,
      BLOOM_FILTER_ENABLED: bloom ? 'true' : 'false',
      METRICS_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  const collect = (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/ping`)).ok) return { base, child, output: () => stderr };
    } catch {
      await sleep(100);
    }
  }
  child.kill('SIGKILL');
  throw new Error(`Server did not start:\n${stderr}`);
};

const stopServer = ({ child }) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });

const absentChecks = async (base) => {
  const res = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
  const match = (await res.text()).match(/kuturl_bloom_filter_checks_total\{result="absent"\} (\d+)/);
  return match ? Number(match[1]) : 0;
};

const waitForFilter = async (base) => {
  for (let i = 0; i < 100; i += 1) {
    const before = await absentChecks(base);
    await fetch(`${base}/${randomCode()}`, { redirect: 'manual' });
    if ((await absentChecks(base)) > before) return;
    await sleep(100);
  }
  throw new Error('The Bloom filter never became ready');
};

const api = async (base, method, path, { key, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key && { Authorization: `Bearer ${key}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok && res.status !== 207) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(data)}`);
  return data;
};

const seed = async (base, keyIds) => {
  const created = await api(base, 'POST', '/api/v1/keys', { body: { name: 'load test' } });
  keyIds.push(created.id);
  const codes = [];
  for (let batch = 0; batch < 2; batch += 1) {
    const result = await api(base, 'POST', '/api/v1/links/bulk', {
      key: created.apiKey,
      body: { links: Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/load/${batch}/${i}` })) },
    });
    for (const item of result.results) if (item.status === 201) codes.push(item.code);
  }
  if (codes.length !== 200) throw new Error(`Expected 200 seeded links, got ${codes.length}`);
  return { apiKey: created.apiKey, codes };
};

const fire = (base, request, { duration, record }) =>
  new Promise((resolve, reject) => {
    const times = [];
    const statuses = {};
    const instance = autocannon(
      { url: base, connections, duration, timeout: 10, requests: [request] },
      (error, result) => (error ? reject(error) : resolve({ times, statuses, result }))
    );
    if (record) {
      instance.on('response', (client, statusCode, bytes, responseTime) => {
        times.push(responseTime);
        statuses[statusCode] = (statuses[statusCode] || 0) + 1;
      });
    }
  });

const transactions = async (db) => {
  await sleep(1500);
  const { rows } = await db.query('SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()');
  return Number(rows[0].n);
};

const run = async (db, base, name, request, expected) => {
  await fire(base, request, { duration: 2, record: false });
  const before = await transactions(db);
  const { times, statuses, result } = await fire(base, request, { duration: durationSeconds, record: true });
  const queries = (await transactions(db)) - before;
  const summary = summarize({
    name,
    times,
    statuses,
    expected,
    durationSeconds,
    errors: result.errors,
    timeouts: result.timeouts,
    queries,
  });
  console.log(`${name}: ${summary.perSecond} req/s, p50 ${summary.p50} ms, p95 ${summary.p95} ms, p99 ${summary.p99} ms, ${summary.queriesPerRequest} Postgres transactions per request`);
  return summary;
};

const scenarios = {
  hot: (data) => ({
    method: 'GET',
    setupRequest: (req) => ({ ...req, path: `/${pick(data.codes)}` }),
  }),
  unknown: () => ({
    method: 'GET',
    setupRequest: (req) => ({ ...req, path: `/${randomCode()}` }),
  }),
  create: (data) => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${data.apiKey}`, 'Content-Type': 'application/json' },
    setupRequest: (req) => ({ ...req, path: '/api/v1/links', body: JSON.stringify({ url: `https://example.com/load/${randomCode()}` }) }),
  }),
  stats: (data) => ({
    method: 'GET',
    headers: { Authorization: `Bearer ${data.apiKey}` },
    setupRequest: (req) => ({ ...req, path: `/api/v1/links/${pick(data.codes)}/stats` }),
  }),
  list: (data) => ({
    method: 'GET',
    path: '/api/v1/links?limit=20',
    headers: { Authorization: `Bearer ${data.apiKey}` },
  }),
};

const cleanUp = async (db, keyIds) => {
  await db.query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  const redis = new Redis(process.env.REDIS_URL);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.quit();
};

const main = async () => {
  const results = [];
  const keyIds = [];
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let server = null;
  try {
    server = await startServer({ bloom: true });
    const data = await seed(server.base, keyIds);
    await waitForFilter(server.base);

    results.push(await run(db, server.base, 'Redirect, cached link', scenarios.hot(data), [302]));
    results.push(await run(db, server.base, 'Redirect, unknown code', scenarios.unknown(data), [404]));
    results.push(await run(db, server.base, 'Create link', scenarios.create(data), [201]));
    results.push(await run(db, server.base, 'Click totals', scenarios.stats(data), [200]));
    results.push(await run(db, server.base, 'List links', scenarios.list(data), [200]));
    await stopServer(server);

    server = await startServer({ bloom: false });
    results.push(await run(db, server.base, 'Redirect, cached link, Bloom filter off', scenarios.hot(data), [302]));
    results.push(await run(db, server.base, 'Redirect, unknown code, Bloom filter off', scenarios.unknown(data), [404]));
    await stopServer(server);
    server = null;
  } catch (error) {
    if (server) console.error(server.output());
    throw error;
  } finally {
    if (server) await stopServer(server);
    if (keyIds.length > 0) await cleanUp(db, keyIds);
    await db.end();
  }

  const markdown = toMarkdown(results, { connections, durationSeconds, node: process.versions.node, cpus: os.availableParallelism() });
  writeFileSync(resultsPath, `${JSON.stringify({ connections, durationSeconds, results }, null, 2)}\n`);
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Load test\n\n${markdown}\n`);

  const problems = results.flatMap((result) => problemsWith(result).map((problem) => `${result.name}: ${problem}`));
  if (problems.length > 0) {
    console.error(`\nLoad test failed:\n${problems.join('\n')}`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
