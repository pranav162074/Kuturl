import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import rateLimits from '../src/config/rateLimits.js';
import rateLimit from '../src/middleware/rateLimit.js';
import { consume, resetRateLimiterBreaker } from '../src/services/rateLimiter.js';
import { clientKey } from '../src/utils/clientKey.js';

const originalEnabled = rateLimits.enabled;
const originalPolicies = structuredClone(rateLimits.policies);
const keyIds = [];
const codes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ipCounter = 0;
const freshIp = () => {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

const freshId = () => `test-${randomUUID()}`;

const from = (ip) => ({
  get: (path) => request(app).get(path).set('X-Forwarded-For', ip),
  post: (path) => request(app).post(path).set('X-Forwarded-For', ip),
});

const makeKey = async (name = 'rate limit test') => {
  const wasEnabled = rateLimits.enabled;
  rateLimits.enabled = false;
  const res = await request(app).post('/api/v1/keys').send({ name });
  rateLimits.enabled = wasEnabled;
  expect(res.status).toBe(201);
  keyIds.push(res.body.id);
  return res.body.apiKey;
};

const withKey = (apiKey, ip = freshIp()) => ({
  get: (path) => from(ip).get(path).set('Authorization', `Bearer ${apiKey}`),
  post: (path) => from(ip).post(path).set('Authorization', `Bearer ${apiKey}`),
});

const deleteRateLimitKeys = async () => {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
};

beforeAll(deleteRateLimitKeys);

afterEach(() => {
  vi.restoreAllMocks();
  resetRateLimiterBreaker();
  rateLimits.enabled = originalEnabled;
  rateLimits.policies = structuredClone(originalPolicies);
});

afterAll(async () => {
  await deleteRateLimitKeys();
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  await closePool();
  await redis.quit();
});

describe('client keys', () => {
  it('uses an IPv4 address as it is', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps an IPv4 address inside IPv6, so both forms share a bucket', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by their first 64 bits', () => {
    const a = clientKey('2001:db8:abcd:12:1:2:3:4');
    const b = clientKey('2001:db8:abcd:12:ffff:ffff:ffff:ffff');
    const c = clientKey('2001:db8:abcd:13::1');

    expect(a).toBe('v6:2001:db8:abcd:12');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('treats different spellings of the same IPv6 network alike', () => {
    expect(clientKey('2001:0DB8:0000:0000::1')).toBe(clientKey('2001:db8::2'));
  });

  it('ignores an interface suffix', () => {
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::2'));
  });

  it('puts missing or empty addresses in one shared bucket', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
    expect(clientKey(42)).toBe('unknown');
  });
});

describe('token bucket', () => {
  const slow = { capacity: 3, refillPerSecond: 0.001 };

  it('allows a burst up to the capacity, then refuses', async () => {
    const id = freshId();
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await consume('test', id, slow));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results.every((r) => r.limit === 3)).toBe(true);
  });

  it('says how long to wait when it refuses', async () => {
    const id = freshId();
    const policy = { capacity: 1, refillPerSecond: 0.1 };
    await consume('test', id, policy);
    const refused = await consume('test', id, policy);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(9);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(10);
    expect(refused.resetSeconds).toBeLessThanOrEqual(10);
  });

  it('reports no wait when it allows', async () => {
    const result = await consume('test', freshId(), slow);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it('refills over time', async () => {
    const id = freshId();
    const policy = { capacity: 2, refillPerSecond: 20 };
    await consume('test', id, policy);
    await consume('test', id, policy);
    expect((await consume('test', id, policy)).allowed).toBe(false);

    await sleep(120);
    expect((await consume('test', id, policy)).allowed).toBe(true);
  });

  it('never refills past the capacity', async () => {
    const id = freshId();
    const policy = { capacity: 2, refillPerSecond: 50 };
    await consume('test', id, policy);
    await sleep(200);

    const results = [];
    for (let i = 0; i < 3; i += 1) results.push((await consume('test', id, policy)).allowed);
    expect(results).toEqual([true, true, false]);
  });

  it('keeps separate buckets for separate identities and policies', async () => {
    const id = freshId();
    const policy = { capacity: 1, refillPerSecond: 0.001 };
    expect((await consume('one', id, policy)).allowed).toBe(true);
    expect((await consume('one', id, policy)).allowed).toBe(false);

    expect((await consume('two', id, policy)).allowed).toBe(true);
    expect((await consume('one', freshId(), policy)).allowed).toBe(true);
  });

  it('charges the cost it is given', async () => {
    const id = freshId();
    const policy = { capacity: 10, refillPerSecond: 0.001 };

    const first = await consume('test', id, policy, 7);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(3);

    const second = await consume('test', id, policy, 4);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(3);

    expect((await consume('test', id, policy, 3)).allowed).toBe(true);
  });

  it('does not spend tokens on a refused request', async () => {
    const id = freshId();
    const policy = { capacity: 5, refillPerSecond: 0.001 };
    await consume('test', id, policy, 4);
    expect((await consume('test', id, policy, 2)).allowed).toBe(false);
    expect((await consume('test', id, policy, 1)).allowed).toBe(true);
  });

  it('never lets simultaneous requests spend the same token', async () => {
    const id = freshId();
    const policy = { capacity: 10, refillPerSecond: 0.001 };
    const results = await Promise.all(Array.from({ length: 60 }, () => consume('test', id, policy)));

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
  });

  it('stores the bucket with an expiry, so idle buckets disappear', async () => {
    const id = freshId();
    await consume('test', id, { capacity: 4, refillPerSecond: 0.5 }, 2);
    const ttl = await redis.pttl(`rl:test:${id}`);

    expect(ttl).toBeGreaterThan(3000);
    expect(ttl).toBeLessThanOrEqual(4000);
  });

  it('keeps a bucket at least one second, even when it is already full', async () => {
    const id = freshId();
    await consume('test', id, { capacity: 1000, refillPerSecond: 1_000_000 });
    expect(await redis.pttl(`rl:test:${id}`)).toBeGreaterThan(500);
  });

  it('rejects policies and costs that make no sense', async () => {
    await expect(consume('test', freshId(), { capacity: 0, refillPerSecond: 1 })).rejects.toThrow(RangeError);
    await expect(consume('test', freshId(), { capacity: 5, refillPerSecond: 0 })).rejects.toThrow(RangeError);
    await expect(consume('test', freshId(), { capacity: 5, refillPerSecond: 1 }, 0)).rejects.toThrow(RangeError);
    await expect(consume('test', freshId(), { capacity: 5, refillPerSecond: 1 }, 6)).rejects.toThrow(RangeError);
  });
});

describe('when Redis fails', () => {
  const policy = { capacity: 5, refillPerSecond: 1 };

  it('returns null instead of throwing', async () => {
    vi.spyOn(redis, 'tokenBucket').mockRejectedValue(new Error('redis is down'));
    expect(await consume('test', freshId(), policy)).toBeNull();
  });

  it('gives up on a slow Redis', async () => {
    vi.spyOn(redis, 'tokenBucket').mockImplementation(() => new Promise(() => {}));
    const started = Date.now();

    expect(await consume('test', freshId(), policy)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('stops asking Redis for a while after a failure', async () => {
    const call = vi.spyOn(redis, 'tokenBucket').mockRejectedValue(new Error('redis is down'));
    await consume('test', freshId(), policy);
    await consume('test', freshId(), policy);
    await consume('test', freshId(), policy);

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('asks again once the breaker is reset', async () => {
    vi.spyOn(redis, 'tokenBucket').mockRejectedValueOnce(new Error('blip'));
    expect(await consume('test', freshId(), policy)).toBeNull();

    resetRateLimiterBreaker();
    expect((await consume('test', freshId(), policy)).allowed).toBe(true);
  });
});

describe('rate limit middleware', () => {
  beforeEach(() => {
    rateLimits.enabled = true;
  });

  it('refuses unknown policies and scopes when the routes are built', () => {
    expect(() => rateLimit('nope', { scope: 'ip' })).toThrow(/Unknown rate limit policy/);
    expect(() => rateLimit('apiIp', { scope: 'nope' })).toThrow(/Unknown rate limit scope/);
  });

  it('sends the rate limit headers on allowed requests', async () => {
    const apiKey = await makeKey();
    const res = await withKey(apiKey).get('/api/v1/keys/me');

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('100');
    expect(Number(res.headers['ratelimit-remaining'])).toBe(99);
    expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(0);
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('answers 429 with Retry-After once the IP bucket is empty', async () => {
    rateLimits.policies.apiIp = { capacity: 2, refillPerSecond: 0.01, failOpen: true };
    const client = from(freshIp());

    expect((await client.get('/api/v1/links')).status).toBe(401);
    expect((await client.get('/api/v1/links')).status).toBe(401);
    const res = await client.get('/api/v1/links');

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) });
    expect(Number(res.headers['retry-after'])).toBe(res.body.retryAfterSeconds);
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res.headers['ratelimit-remaining']).toBe('0');
  });

  it('limits by IP before authentication, so key guessing is slowed down', async () => {
    rateLimits.policies.apiIp = { capacity: 3, refillPerSecond: 0.01, failOpen: true };
    const ip = freshIp();
    const guesses = [];
    for (let i = 0; i < 5; i += 1) {
      guesses.push((await from(ip).get('/api/v1/keys/me').set('Authorization', 'Bearer kt_wrong')).status);
    }
    expect(guesses).toEqual([401, 401, 401, 429, 429]);
  });

  it('keeps separate IP buckets for separate clients', async () => {
    rateLimits.policies.apiIp = { capacity: 1, refillPerSecond: 0.01, failOpen: true };
    const first = from(freshIp());
    await first.get('/api/v1/links');
    expect((await first.get('/api/v1/links')).status).toBe(429);

    expect((await from(freshIp()).get('/api/v1/links')).status).toBe(401);
  });

  it('shares one bucket across an IPv6 /64', async () => {
    rateLimits.policies.apiIp = { capacity: 1, refillPerSecond: 0.01, failOpen: true };
    const prefix = `2001:db8:${(ipCounter += 1).toString(16)}:1`;

    expect((await from(`${prefix}::1`).get('/api/v1/links')).status).toBe(401);
    expect((await from(`${prefix}:aaaa:bbbb:cccc:dddd`).get('/api/v1/links')).status).toBe(429);
  });

  it('allows only five new keys per hour from one IP', async () => {
    const client = from(freshIp());
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await client.post('/api/v1/keys').send({ name: 'burst' });
      if (res.status === 201) keyIds.push(res.body.id);
      statuses.push(res.status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('charges key creation even when the body is invalid', async () => {
    rateLimits.policies.keyCreation = { capacity: 1, refillPerSecond: 0.001, failOpen: false };
    const client = from(freshIp());

    expect((await client.post('/api/v1/keys').send({ name: 42 })).status).toBe(400);
    expect((await client.post('/api/v1/keys').send({ name: 'valid' })).status).toBe(429);
  });

  it('limits each API key separately, even from the same IP', async () => {
    rateLimits.policies.apiKey = { capacity: 2, refillPerSecond: 0.01, failOpen: true };
    const ip = freshIp();
    const first = withKey(await makeKey(), ip);
    const second = withKey(await makeKey(), ip);

    expect((await first.get('/api/v1/links')).status).toBe(200);
    expect((await first.get('/api/v1/links')).status).toBe(200);
    expect((await first.get('/api/v1/links')).status).toBe(429);

    expect((await second.get('/api/v1/links')).status).toBe(200);
  });

  it('follows the API key across IPs', async () => {
    rateLimits.policies.apiKey = { capacity: 1, refillPerSecond: 0.01, failOpen: true };
    const apiKey = await makeKey();

    expect((await withKey(apiKey, freshIp()).get('/api/v1/keys/me')).status).toBe(200);
    expect((await withKey(apiKey, freshIp()).get('/api/v1/keys/me')).status).toBe(429);
  });

  it('has a tighter bucket for creating links than for reading them', async () => {
    rateLimits.policies.linkCreation = { capacity: 2, refillPerSecond: 0.01, failOpen: true };
    const client = withKey(await makeKey());

    for (let i = 0; i < 2; i += 1) {
      const res = await client.post('/api/v1/links').send({ url: 'https://example.com/limited' });
      expect(res.status).toBe(201);
      codes.add(res.body.code);
    }
    const refused = await client.post('/api/v1/links').send({ url: 'https://example.com/limited' });

    expect(refused.status).toBe(429);
    expect(refused.headers['ratelimit-limit']).toBe('2');
    expect((await client.get('/api/v1/links')).status).toBe(200);
  });

  it('does not limit redirects or health checks', async () => {
    rateLimits.policies.apiIp = { capacity: 1, refillPerSecond: 0.01, failOpen: true };
    const client = from(freshIp());

    for (let i = 0; i < 5; i += 1) {
      const res = await client.get('/zzzzzzz');
      expect(res.status).not.toBe(429);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await client.get('/ping')).status).toBe(200);
    }
  });

  it('does nothing when rate limiting is switched off', async () => {
    rateLimits.enabled = false;
    rateLimits.policies.apiIp = { capacity: 1, refillPerSecond: 0.01, failOpen: true };
    const client = from(freshIp());

    for (let i = 0; i < 3; i += 1) {
      const res = await client.get('/api/v1/links');
      expect(res.status).toBe(401);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
  });

  it('lets requests through when Redis is down', async () => {
    const apiKey = await makeKey();
    vi.spyOn(redis, 'tokenBucket').mockRejectedValue(new Error('redis is down'));

    const res = await withKey(apiKey).get('/api/v1/keys/me');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('refuses key creation with 503 when Redis is down', async () => {
    vi.spyOn(redis, 'tokenBucket').mockRejectedValue(new Error('redis is down'));
    const res = await from(freshIp()).post('/api/v1/keys').send({ name: 'during outage' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
    expect(await query('SELECT 1 FROM api_keys WHERE name = $1', ['during outage'])).toHaveProperty('rowCount', 0);
  });
});
