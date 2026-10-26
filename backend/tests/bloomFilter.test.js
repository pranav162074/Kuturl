import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { createRedisConnection } from '../src/config/redisConnection.js';
import settings from '../src/config/linkFilter.js';
import { reserveLinkId, insertLink } from '../src/db/links.js';
import codes from '../src/services/codes.js';
import linkFilter from '../src/services/linkFilter.js';
import { resetBreaker } from '../src/services/linkCache.js';
import { createBloomFilter, sizeFor } from '../src/utils/bloomFilter.js';

const original = { ...settings };
const keyIds = [];
const touched = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomCode = () => randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 7);

let apiKey;
let apiKeyId;

const makeLink = async () => {
  const res = await request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send({ url: 'https://example.com/filtered' });
  touched.add(res.body.code);
  return res.body.code;
};

const plantLink = async () => {
  const id = await reserveLinkId();
  const code = codes.encode(id);
  touched.add(code);
  await insertLink({ id, code, longUrl: 'https://example.com/planted', apiKeyId });
  return code;
};

const waitFor = async (check, timeoutMs = 2000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
};

const metric = async (name, labels) => {
  const text = (await request(app).get('/metrics')).text;
  const line = text.split('\n').find((l) => l.startsWith(`${name}{${labels}}`) || l.startsWith(`${name} `));
  return line ? Number(line.split(' ').at(-1)) : 0;
};

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'bloom filter test' });
  apiKey = res.body.apiKey;
  apiKeyId = res.body.id;
  keyIds.push(apiKeyId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetBreaker();
  await linkFilter.stop();
  Object.assign(settings, original);
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (touched.size > 0) await redis.del(...[...touched].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('the Bloom filter', () => {
  it('sizes itself from the capacity and the target false positive rate', () => {
    expect(sizeFor(1_000_000, 0.01)).toEqual({ bits: 9_585_059, hashes: 7 });
    expect(sizeFor(100_000, 0.001).hashes).toBe(10);
    expect(() => createBloomFilter({ capacity: 0, falsePositiveRate: 0.01 })).toThrow(RangeError);
    expect(() => createBloomFilter({ capacity: 10, falsePositiveRate: 1 })).toThrow(RangeError);
  });

  it('never forgets a code it was given', () => {
    const filter = createBloomFilter({ capacity: 20_000, falsePositiveRate: 0.01 });
    const added = Array.from({ length: 20_000 }, randomCode);
    for (const code of added) filter.add(code);
    expect(added.every((code) => filter.mightContain(code))).toBe(true);
    expect(filter.count).toBe(20_000);
  });

  it('wrongly passes about 1% of absent codes when full, as designed', () => {
    const filter = createBloomFilter({ capacity: 50_000, falsePositiveRate: 0.01 });
    for (let i = 0; i < 50_000; i += 1) filter.add(randomCode());

    let passed = 0;
    for (let i = 0; i < 100_000; i += 1) if (filter.mightContain(`absent${i}`)) passed += 1;
    const rate = passed / 100_000;

    expect(rate).toBeGreaterThan(0.005);
    expect(rate).toBeLessThan(0.015);
    expect(filter.estimatedFalsePositiveRate()).toBeCloseTo(0.01, 2);
  });

  it('treats letter case as part of the code', () => {
    const filter = createBloomFilter({ capacity: 100, falsePositiveRate: 0.0001 });
    filter.add('AbCdEfG');
    expect(filter.mightContain('AbCdEfG')).toBe(true);
    expect(filter.mightContain('abcdefg')).toBe(false);
  });
});

describe('the link filter in front of redirects', () => {
  it('lets everything through before it is built', async () => {
    const code = randomCode();
    touched.add(code);
    const res = await request(app).get(`/${code}`);
    expect(res.status).toBe(404);
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('answers unknown codes from memory, without touching Redis or Postgres', async () => {
    const existing = await makeLink();
    await linkFilter.start();
    expect(linkFilter.isReady()).toBe(true);

    const get = vi.spyOn(redis, 'get');
    const lookups = vi.spyOn(pool, 'query');
    const code = randomCode();
    const res = await request(app).get(`/${code}`);

    expect(res.status).toBe(404);
    expect(res.headers['x-cache']).toBe('FILTERED');
    expect(get).not.toHaveBeenCalled();
    expect(lookups).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    expect((await request(app).get(`/${existing}`)).status).toBe(302);
  });

  it('knows about a link created by this instance at once', async () => {
    await linkFilter.start();
    const code = await makeLink();
    expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('learns links created by other instances through Redis', async () => {
    await linkFilter.start();
    const code = await plantLink();
    expect(linkFilter.mightExist(code)).toBe(false);

    await redis.publish(settings.channel, code);

    expect(await waitFor(() => linkFilter.mightExist(code))).toBe(true);
    expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('catches up from Postgres on a refresh, for anything an announcement missed', async () => {
    await linkFilter.start();
    const code = await plantLink();
    expect((await request(app).get(`/${code}`)).headers['x-cache']).toBe('FILTERED');

    await linkFilter.refresh();

    expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('refreshes when its Redis connection comes back', async () => {
    const connection = createRedisConnection('Test filter');
    await linkFilter.start({ connection });
    const code = await plantLink();
    expect(linkFilter.mightExist(code)).toBe(false);

    connection.emit('ready');

    expect(await waitFor(() => linkFilter.mightExist(code))).toBe(true);
  });

  it('keeps codes announced while it is being rebuilt', async () => {
    await linkFilter.start();
    const realQuery = pool.query.bind(pool);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(pool, 'query').mockImplementation(async (text, params) => {
      if (String(text).startsWith('SELECT id, code FROM links')) await gate;
      return realQuery(text, params);
    });

    const rebuilding = linkFilter.rebuild();
    const announced = randomCode();
    touched.add(announced);
    await linkFilter.announce(announced);
    release();
    await rebuilding;

    expect(linkFilter.mightExist(announced)).toBe(true);
  });

  it('still answers through the cache for links deleted since it was built', async () => {
    await linkFilter.start();
    const code = await makeLink();
    await request(app).delete(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`);

    const res = await request(app).get(`/${code}`);
    expect(res.status).toBe(404);
    expect(res.headers['x-cache']).not.toBe('FILTERED');
  });

  it('starts empty-handed when Postgres is down, and builds on the next refresh', async () => {
    const failing = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database down'));

    await linkFilter.start();
    expect(failing).toHaveBeenCalled();
    expect(linkFilter.isReady()).toBe(false);
    expect(linkFilter.mightExist(randomCode())).toBe(true);

    vi.restoreAllMocks();
    await linkFilter.refresh();
    expect(linkFilter.isReady()).toBe(true);
  });

  it('grows when more codes arrive than it was sized for', async () => {
    settings.minCapacity = 10;
    settings.growth = 1.01;
    await linkFilter.start();
    const before = linkFilter.stats();

    for (let i = 0; i <= before.capacity; i += 1) linkFilter.add(randomCode());
    expect(linkFilter.stats().items).toBeGreaterThan(before.capacity);

    await linkFilter.refresh();
    const after = linkFilter.stats();
    expect(after.items).toBeLessThanOrEqual(after.capacity);
  });

  it('does nothing when switched off', async () => {
    settings.enabled = false;
    await linkFilter.start();
    expect(linkFilter.isReady()).toBe(false);
    expect((await request(app).get(`/${randomCode()}`)).headers['x-cache']).toBe('MISS');
  });

  it('reports its checks and size as metrics', async () => {
    await linkFilter.start();
    const before = await metric('kuturl_bloom_filter_checks_total', 'result="absent"');
    await request(app).get(`/${randomCode()}`);
    await request(app).get(`/${randomCode()}`);

    expect((await metric('kuturl_bloom_filter_checks_total', 'result="absent"')) - before).toBe(2);
    expect(await metric('kuturl_bloom_filter_capacity')).toBeGreaterThanOrEqual(settings.minCapacity);
    expect(await metric('kuturl_bloom_filter_bytes')).toBeGreaterThan(0);
    expect(await metric('kuturl_redirects_total', 'outcome="not_found",cache="filtered"')).toBeGreaterThanOrEqual(2);
  });
});
