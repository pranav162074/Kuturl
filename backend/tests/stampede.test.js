import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { jitter, resetBreaker, TTL_SECONDS } from '../src/services/linkCache.js';
import { inFlightLookups } from '../src/services/redirect.js';

const keyIds = [];
const codes = new Set();
const LOOKUP = 'SELECT * FROM links WHERE code = $1';
const cacheKey = (code) => `link:${code}`;

let apiKey;

const makeLink = async (body = {}) => {
  const res = await request(app)
    .post('/api/v1/links')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ url: 'https://example.com/popular', ...body });
  codes.add(res.body.code);
  await redis.del(cacheKey(res.body.code));
  return res.body.code;
};

const countLookups = (delayMs = 0) => {
  const original = pool.query.bind(pool);
  const calls = [];
  vi.spyOn(pool, 'query').mockImplementation(async (text, params) => {
    if (text === LOOKUP) {
      calls.push(params[0]);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return original(text, params);
  });
  return calls;
};

const burst = (path, count) => Promise.all(Array.from({ length: count }, () => request(app).get(path)));

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'stampede test' });
  apiKey = res.body.apiKey;
  keyIds.push(res.body.id);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (codes.size > 0) await redis.del(...[...codes].map(cacheKey));
  await closePool();
  await redis.quit();
});

describe('request coalescing', () => {
  it('answers 100 simultaneous misses for one link with a single database query', async () => {
    const code = await makeLink();
    const lookups = countLookups(50);

    const results = await burst(`/${code}`, 100);

    expect(results.every((res) => res.status === 302)).toBe(true);
    expect(results.every((res) => res.headers.location === 'https://example.com/popular')).toBe(true);
    expect(lookups).toEqual([code]);
    expect(inFlightLookups()).toBe(0);
  });

  it('does the same for codes that do not exist', async () => {
    await redis.del(cacheKey('nothere'));
    const lookups = countLookups(50);
    const results = await burst('/nothere', 100);

    expect(results.every((res) => res.status === 404)).toBe(true);
    expect(lookups).toEqual(['nothere']);
    await redis.del(cacheKey('nothere'));
  });

  it('keeps different links apart', async () => {
    const first = await makeLink();
    const second = await makeLink({ url: 'https://example.com/other' });
    const lookups = countLookups(50);

    const results = await Promise.all([...(await Promise.all([burst(`/${first}`, 30), burst(`/${second}`, 30)]))].flat());

    expect(results.every((res) => res.status === 302)).toBe(true);
    expect(lookups.sort()).toEqual([first, second].sort());
  });

  it('serves the rest from the cache once the first lookup is done', async () => {
    const code = await makeLink();
    const lookups = countLookups();

    expect((await request(app).get(`/${code}`)).headers['x-cache']).toBe('MISS');
    const later = await burst(`/${code}`, 20);

    expect(later.every((res) => res.headers['x-cache'] === 'HIT')).toBe(true);
    expect(lookups).toHaveLength(1);
  });

  it('looks again after the shared lookup has finished, so nothing stays stuck', async () => {
    const code = await makeLink();
    const lookups = countLookups();

    await request(app).get(`/${code}`);
    await redis.del(cacheKey(code));
    await request(app).get(`/${code}`);

    expect(lookups).toEqual([code, code]);
  });

  it('gives every waiting request the same database error, then recovers', async () => {
    const code = await makeLink();
    const original = pool.query.bind(pool);
    let failures = 0;
    vi.spyOn(pool, 'query').mockImplementation(async (text, params) => {
      if (text === LOOKUP && failures === 0) {
        failures += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('database blip');
      }
      return original(text, params);
    });

    const results = await burst(`/${code}`, 20);
    expect(results.every((res) => res.status === 500)).toBe(true);
    expect(failures).toBe(1);
    expect(inFlightLookups()).toBe(0);

    expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('still coalesces when Redis is down and every request goes to the database', async () => {
    const code = await makeLink();
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('redis is down'));
    const lookups = countLookups(50);

    const results = await burst(`/${code}`, 50);

    expect(results.every((res) => res.status === 302)).toBe(true);
    expect(lookups).toHaveLength(1);
  });

  it('counts the requests that shared a lookup', async () => {
    const code = await makeLink();
    countLookups(50);
    const before = await request(app).get('/metrics');
    await burst(`/${code}`, 25);
    const after = await request(app).get('/metrics');
    const read = (text) => Number(/^kuturl_redirect_coalesced_lookups_total (\S+)$/m.exec(text)[1]);

    expect(read(after.text) - read(before.text)).toBe(24);
  });
});

describe('cache lifetime jitter', () => {
  it('only ever shortens a lifetime, by at most 10%', () => {
    expect(jitter(3600, () => 0)).toBe(3600);
    expect(jitter(3600, () => 0.999999)).toBe(3241);
    expect(jitter(30, () => 0.999999)).toBe(28);
    expect(jitter(1, () => 0.999999)).toBe(1);
    for (let i = 0; i < 1000; i += 1) {
      const ttl = jitter(3600);
      expect(ttl).toBeGreaterThan(3240);
      expect(ttl).toBeLessThanOrEqual(3600);
    }
  });

  it('spreads the expiry of links cached at the same moment', async () => {
    const created = [];
    for (let i = 0; i < 20; i += 1) created.push(await makeLink({ url: `https://example.com/spread/${i}` }));
    await Promise.all(created.map((code) => request(app).get(`/${code}`)));

    const ttls = await Promise.all(created.map((code) => redis.ttl(cacheKey(code))));
    expect(new Set(ttls).size).toBeGreaterThan(5);
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThan(TTL_SECONDS.active * 0.9 - 2);
      expect(ttl).toBeLessThanOrEqual(TTL_SECONDS.active);
    }
  });

  it('never lets a jittered entry outlive the link itself', async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const code = await makeLink({ expiresAt });
    await request(app).get(`/${code}`);

    expect(await redis.ttl(cacheKey(code))).toBeLessThanOrEqual(120);
  });
});
