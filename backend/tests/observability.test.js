import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import env from '../src/config/env.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import analytics from '../src/config/analytics.js';
import rateLimits from '../src/config/rateLimits.js';
import { watchClickStream } from '../src/config/metrics.js';
import { accessLogOptions } from '../src/config/accessLog.js';
import { resetBreaker } from '../src/services/linkCache.js';
import { resetRateLimiterBreaker } from '../src/services/rateLimiter.js';
import { createClickWorker } from '../src/worker/clickWorker.js';
import { createMetricsServer } from '../src/worker/metricsServer.js';

const originalEnv = { ...env };
const originalAnalytics = { ...analytics };
const originalPolicies = structuredClone(rateLimits.policies);
const keyIds = [];
const codes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let apiKey;

const scrape = async () => {
  watchClickStream(redis);
  const res = await request(app).get('/metrics');
  expect(res.status).toBe(200);
  return res.text;
};

const parseLabels = (text) =>
  Object.fromEntries([...(text ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));

const series = (text, name) =>
  text
    .split('\n')
    .map((line) => /^(\w+)(?:\{(.*)\})? (\S+)$/.exec(line))
    .filter((match) => match && match[1] === name)
    .map((match) => ({ labels: parseLabels(match[2]), value: Number(match[3]) }));

const value = (text, name, labels = {}) => {
  const found = series(text, name).find((entry) =>
    Object.entries(labels).every(([key, expected]) => entry.labels[key] === expected)
  );
  return found ? found.value : 0;
};

const delta = async (name, labels, action) => {
  const before = value(await scrape(), name, labels);
  await action();
  return value(await scrape(), name, labels) - before;
};

const makeLink = async (url = 'https://example.com/observed') => {
  const res = await request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send({ url });
  codes.add(res.body.code);
  return res.body.code;
};

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'observability test' });
  apiKey = res.body.apiKey;
  keyIds.push(res.body.id);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
  resetRateLimiterBreaker();
  Object.assign(env, originalEnv);
  Object.assign(analytics, originalAnalytics);
  rateLimits.enabled = false;
  rateLimits.policies = structuredClone(originalPolicies);
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  const streams = await redis.keys('test:observe:*');
  if (streams.length > 0) await redis.del(...streams);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('the metrics endpoint', () => {
  it('serves Prometheus text, including process and Node.js metrics', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    for (const name of ['process_cpu_user_seconds_total', 'nodejs_eventloop_lag_seconds', 'nodejs_heap_size_used_bytes']) {
      expect(res.text).toContain(`# TYPE ${name}`);
    }
  });

  it('reports the Postgres pool', async () => {
    const text = await scrape();
    expect(series(text, 'kuturl_db_pool_connections').map((entry) => entry.labels.state).sort()).toEqual([
      'idle',
      'total',
      'waiting',
    ]);
  });

  it('is open in development, needs the token when one is set, and is off in production without one', async () => {
    expect((await request(app).get('/metrics')).status).toBe(200);

    env.metricsToken = 'a-metrics-token-for-tests';
    expect((await request(app).get('/metrics')).status).toBe(401);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token-of-some-length')).status).toBe(401);
    expect((await request(app).get('/metrics').set('Authorization', 'Basic a-metrics-token-for-tests')).status).toBe(401);
    const allowed = await request(app).get('/metrics').set('Authorization', 'Bearer a-metrics-token-for-tests');
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain('http_request_duration_seconds');

    env.metricsToken = undefined;
    env.isProduction = true;
    expect((await request(app).get('/metrics')).status).toBe(404);
  });
});

describe('request metrics', () => {
  it('labels requests by route template, never by the code in the URL', async () => {
    const code = await makeLink();
    await request(app).get(`/${code}`);
    await request(app).get(`/api/v1/links/${code}/stats`).set('Authorization', `Bearer ${apiKey}`);
    const text = await scrape();

    expect(text).not.toContain(code);
    expect(value(text, 'http_request_duration_seconds_count', { route: '/:code', status: '302' })).toBeGreaterThan(0);
    expect(value(text, 'http_request_duration_seconds_count', { route: '/api/v1/links/:code/stats' })).toBeGreaterThan(0);
    expect(value(text, 'http_request_duration_seconds_count', { method: 'POST', route: '/api/v1/links', status: '201' })).toBeGreaterThan(0);
  });

  it('groups requests rejected before routing by their API prefix', async () => {
    await request(app).get('/api/v1/links');
    await request(app).get('/api/v1/keys/me');
    await request(app).get('/api/v1/nothing-here');
    await request(app).get('/not/a/route');
    const text = await scrape();

    expect(value(text, 'http_request_duration_seconds_count', { route: '/api/v1/links/*', status: '401' })).toBeGreaterThan(0);
    expect(value(text, 'http_request_duration_seconds_count', { route: '/api/v1/keys/me', status: '401' })).toBeGreaterThan(0);
    expect(value(text, 'http_request_duration_seconds_count', { route: '/api/v1/*', status: '404' })).toBeGreaterThan(0);
    expect(value(text, 'http_request_duration_seconds_count', { route: 'unmatched', status: '404' })).toBeGreaterThan(0);
  });

  it('keeps the number of route labels small, however many different URLs arrive', async () => {
    for (let i = 0; i < 40; i += 1) {
      await request(app).get(`/${randomUUID().slice(0, 7)}`);
      await request(app).get(`/api/v1/links/${randomUUID().slice(0, 7)}`).set('Authorization', `Bearer ${apiKey}`);
      await request(app).get(`/deep/${randomUUID()}/path`);
    }
    const routes = new Set(series(await scrape(), 'http_request_duration_seconds_count').map((entry) => entry.labels.route));
    expect(routes.size).toBeLessThan(15);
  });
});

describe('application metrics', () => {
  it('counts cache misses and hits on redirects', async () => {
    const code = await makeLink();
    expect(await delta('kuturl_redirects_total', { outcome: 'redirect', cache: 'miss' }, () => request(app).get(`/${code}`))).toBe(1);
    expect(await delta('kuturl_redirects_total', { outcome: 'redirect', cache: 'hit' }, () => request(app).get(`/${code}`))).toBe(1);
    expect(await delta('kuturl_redirects_total', { outcome: 'not_found', cache: 'skipped' }, () => request(app).get('/bad.code'))).toBe(1);
  });

  it('counts cache errors', async () => {
    const code = await makeLink();
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('redis is down'));
    expect(await delta('kuturl_cache_errors_total', {}, () => request(app).get(`/${code}`))).toBe(1);
  });

  it('counts queued and dropped click events', async () => {
    const code = await makeLink();
    const queued = await delta('kuturl_click_events_total', { outcome: 'queued' }, async () => {
      await request(app).get(`/${code}`);
      await sleep(50);
    });
    expect(queued).toBe(1);

    vi.spyOn(redis, 'xadd').mockRejectedValue(new Error('redis is full'));
    const dropped = await delta('kuturl_click_events_total', { outcome: 'dropped' }, async () => {
      await request(app).get(`/${code}`);
      await sleep(50);
    });
    expect(dropped).toBe(1);
  });

  it('counts rate limit decisions per policy', async () => {
    rateLimits.enabled = true;
    rateLimits.policies.apiIp = { capacity: 1, refillPerSecond: 0.001, failOpen: true };
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    await redis.del(`rl:apiIp:${ip}`);

    const limited = await delta('kuturl_rate_limit_decisions_total', { policy: 'apiIp', outcome: 'limited' }, async () => {
      await request(app).get('/api/v1/links').set('X-Forwarded-For', ip);
      await request(app).get('/api/v1/links').set('X-Forwarded-For', ip);
    });
    expect(limited).toBe(1);
    await redis.del(`rl:apiIp:${ip}`);
  });

  it('counts idempotency outcomes', async () => {
    const key = randomUUID();
    const send = (url) =>
      request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).set('Idempotency-Key', key).send({ url });

    expect(await delta('kuturl_idempotency_requests_total', { outcome: 'new' }, () => send('https://example.com/i'))).toBe(1);
    expect(await delta('kuturl_idempotency_requests_total', { outcome: 'replayed' }, () => send('https://example.com/i'))).toBe(1);
    expect(await delta('kuturl_idempotency_requests_total', { outcome: 'key_reused' }, () => send('https://example.com/j'))).toBe(1);
  });
});

describe('click stream and worker metrics', () => {
  it('reports how many events wait, how many are in flight, and how old the oldest is', async () => {
    analytics.streamKey = `test:observe:${randomUUID()}`;
    const old = Date.now() - 30_000;
    for (let i = 0; i < 3; i += 1) {
      await redis.xadd(analytics.streamKey, `${old + i}-0`, 'id', randomUUID(), 'code', 'abcdefg', 'ts', String(old), 'ref', '', 'dev', 'other');
    }
    await redis.xgroup('CREATE', analytics.streamKey, analytics.group, '0');
    await redis.xreadgroup('GROUP', analytics.group, 'someone', 'COUNT', 2, 'STREAMS', analytics.streamKey, '>');

    const text = await scrape();
    expect(value(text, 'kuturl_click_stream_length')).toBe(3);
    expect(value(text, 'kuturl_click_stream_pending')).toBe(2);
    expect(value(text, 'kuturl_click_stream_oldest_age_seconds')).toBeGreaterThanOrEqual(29);
    expect(value(text, 'kuturl_click_stream_oldest_age_seconds')).toBeLessThan(120);
  });

  it('reports an empty stream as zero', async () => {
    analytics.streamKey = `test:observe:${randomUUID()}`;
    const text = await scrape();
    expect(value(text, 'kuturl_click_stream_length')).toBe(0);
    expect(value(text, 'kuturl_click_stream_oldest_age_seconds')).toBe(0);
  });

  it('counts what the worker recorded, ignored and skipped, and failed batches', async () => {
    analytics.streamKey = `test:observe:${randomUUID()}`;
    const worker = createClickWorker({ redis, consumer: 'observed-worker' });
    await worker.ensureGroup();
    const code = await makeLink();
    const add = (fields) => redis.xadd(analytics.streamKey, '*', ...Object.entries(fields).flat());
    const event = (overrides = {}) => ({ id: randomUUID(), code, ts: String(Date.now()), ref: '', dev: 'mobile', ...overrides });

    await add(event());
    await add(event());
    await add(event({ code: 'nosuch1' }));
    await add({ junk: 'yes' });

    const before = await scrape();
    await worker.runOnce();
    const after = await scrape();
    const change = (name, labels) => value(after, name, labels) - value(before, name, labels);

    expect(change('kuturl_click_worker_events_total', { outcome: 'recorded' })).toBe(2);
    expect(change('kuturl_click_worker_events_total', { outcome: 'ignored' })).toBe(1);
    expect(change('kuturl_click_worker_events_total', { outcome: 'skipped' })).toBe(1);
    expect(change('kuturl_click_worker_batches_total', { outcome: 'ok' })).toBe(1);
    expect(change('kuturl_click_worker_batch_duration_seconds_count')).toBe(1);

    await add(event());
    vi.spyOn(redis, 'multi').mockImplementationOnce(() => {
      throw new Error('lost');
    });
    expect(await delta('kuturl_click_worker_batches_total', { outcome: 'failed' }, () => worker.runOnce().catch(() => {}))).toBe(1);
  });

  it('does not count empty polls as batches', async () => {
    analytics.streamKey = `test:observe:${randomUUID()}`;
    const worker = createClickWorker({ redis, consumer: 'idle-worker' });
    await worker.ensureGroup();
    expect(await delta('kuturl_click_worker_batches_total', { outcome: 'ok' }, () => worker.runOnce())).toBe(0);
  });

  it('serves the same metrics from the standalone worker', async () => {
    const server = createMetricsServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('kuturl_click_worker_batches_total');

      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);

      env.metricsToken = 'a-metrics-token-for-tests';
      expect((await fetch(`${base}/metrics`)).status).toBe(401);
      expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer a-metrics-token-for-tests' } })).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('access logs', () => {
  const { serializers, customProps, customLogLevel } = accessLogOptions;
  const response = (status, cache) => ({ statusCode: status, getHeader: (name) => (name === 'x-cache' ? cache : undefined) });

  it('logs the method, full URL and request id, but no headers and no IP address', () => {
    const logged = serializers.req({
      id: 'req-1',
      method: 'GET',
      url: '/abc',
      headers: { authorization: 'Bearer kt_secret', cookie: 'a=b' },
      remoteAddress: '203.0.113.9',
      remotePort: 5555,
      raw: { originalUrl: '/api/v1/links/abc?limit=5' },
    });
    expect(logged).toEqual({ id: 'req-1', method: 'GET', url: '/api/v1/links/abc?limit=5' });
    expect(serializers.res({ statusCode: 201, headers: { 'set-cookie': 'x' } })).toEqual({ statusCode: 201 });
  });

  it('adds the route template, the API key id and the cache result', () => {
    const req = { route: { path: '/:code' }, baseUrl: '/api/v1/links', apiKey: { id: '42', keyHash: 'never' } };
    expect(customProps(req, response(200, 'HIT'))).toEqual({ route: '/api/v1/links/:code', apiKeyId: '42', cache: 'HIT' });
    expect(customProps({ originalUrl: '/x/y' }, response(404))).toEqual({ route: 'unmatched' });
  });

  it('logs server errors as errors and rate limiting as a warning', () => {
    expect(customLogLevel({}, response(500))).toBe('error');
    expect(customLogLevel({}, response(200), new Error('boom'))).toBe('error');
    expect(customLogLevel({}, response(429))).toBe('warn');
    expect(customLogLevel({}, response(404))).toBe('info');
    expect(customLogLevel({}, response(302))).toBe('info');
  });
});
