import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { createRedisConnection } from '../src/config/redisConnection.js';
import analytics from '../src/config/analytics.js';
import { recordClick } from '../src/services/clickEvents.js';
import {
  recordClicks,
  ensureClickPartition,
  dropOldClickPartitions,
  listClickPartitions,
} from '../src/db/clicks.js';
import { createClickWorker, parseEntry } from '../src/worker/clickWorker.js';
import { deviceClass } from '../src/utils/device.js';
import { referrerHost } from '../src/utils/referrer.js';
import { resetBreaker } from '../src/services/linkCache.js';

const original = { ...analytics };
const keyIds = [];
const codes = new Set();
const hour = 60 * 60 * 1000;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let apiKey;
let apiKeyId;
let worker;

const makeLink = async (url = 'https://example.com/tracked') => {
  const res = await request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send({ url });
  codes.add(res.body.code);
  const { rows } = await query('SELECT id FROM links WHERE code = $1', [res.body.code]);
  return { code: res.body.code, id: rows[0].id };
};

const addEntry = (fields) => redis.xadd(analytics.streamKey, '*', ...Object.entries(fields).flat());

const event = (code, overrides = {}) => ({
  id: randomUUID(),
  code,
  ts: String(Date.now()),
  ref: '',
  dev: 'desktop',
  ...overrides,
});

const entries = async () => redis.xrange(analytics.streamKey, '-', '+');

const waitFor = async (check, timeoutMs = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
};

const clicksFor = async (linkId) =>
  (await query('SELECT * FROM clicks WHERE link_id = $1 ORDER BY clicked_at', [linkId])).rows;

const statsFor = async (linkId) =>
  (await query('SELECT hour, clicks::int AS clicks FROM link_stats_hourly WHERE link_id = $1 ORDER BY hour', [linkId]))
    .rows;

const pendingCount = async () => (await redis.xpending(analytics.streamKey, analytics.group))[0];

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'analytics test' });
  apiKey = res.body.apiKey;
  apiKeyId = res.body.id;
  keyIds.push(apiKeyId);
});

beforeEach(async () => {
  analytics.streamKey = `test:clicks:${randomUUID()}`;
  worker = createClickWorker({ redis, consumer: 'test-worker' });
  await worker.ensureGroup();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
  Object.assign(analytics, original);
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  for (const name of await listClickPartitions()) {
    if (/^clicks_(2020|2030|2031)_/.test(name)) await query(`DROP TABLE IF EXISTS "${name}"`);
  }
  const streams = await redis.keys('test:clicks:*');
  if (streams.length > 0) await redis.del(...streams);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('device classes', () => {
  it.each([
    [IPHONE, 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'tablet'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'tablet'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/121.0', 'desktop'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'bot'],
    ['facebookexternalhit/1.1', 'bot'],
    ['Slackbot-LinkExpanding 1.0', 'bot'],
    ['curl/8.4.0', 'bot'],
    ['python-requests/2.31', 'bot'],
    ['SomethingUnusual/1.0', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ])('%s is %s', (userAgent, expected) => {
    expect(deviceClass(userAgent)).toBe(expected);
  });
});

describe('referrer hosts', () => {
  it('keeps only the host, without www', () => {
    expect(referrerHost('https://www.google.com/search?q=secret')).toBe('google.com');
    expect(referrerHost('http://News.Ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(referrerHost('https://t.co/abc')).toBe('t.co');
  });

  it('ignores anything that is not a web address', () => {
    for (const value of [undefined, '', 'not a url', 'android-app://com.google.app/', 'file:///etc/passwd']) {
      expect(referrerHost(value)).toBeNull();
    }
  });
});

describe('recording clicks on redirect', () => {
  it('adds one event per redirect, with no IP address', async () => {
    const { code } = await makeLink();
    const before = Date.now();
    const res = await request(app)
      .get(`/${code}`)
      .set('User-Agent', IPHONE)
      .set('Referer', 'https://www.google.com/search?q=kuturl');

    expect(res.status).toBe(302);
    expect(await waitFor(async () => (await entries()).length === 1)).toBe(true);

    const [[, fields]] = await entries();
    const recorded = Object.fromEntries(fields.reduce((pairs, value, i) => (i % 2 ? pairs : [...pairs, [value, fields[i + 1]]]), []));
    expect(Object.keys(recorded).sort()).toEqual(['code', 'dev', 'id', 'ref', 'ts']);
    expect(recorded).toMatchObject({ code, dev: 'mobile', ref: 'google.com' });
    expect(Number(recorded.ts)).toBeGreaterThanOrEqual(before);
    expect(recorded.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records nothing for HEAD requests, prefetches, unknown, expired or disabled links', async () => {
    const { code } = await makeLink();
    const disabled = await makeLink();
    await request(app).patch(`/api/v1/links/${disabled.code}`).set('Authorization', `Bearer ${apiKey}`).send({ disabled: true });

    expect((await request(app).head(`/${code}`)).status).toBe(302);
    expect((await request(app).get(`/${code}`).set('Sec-Purpose', 'prefetch')).status).toBe(302);
    expect((await request(app).get(`/${code}`).set('Purpose', 'prefetch')).status).toBe(302);
    expect((await request(app).get('/zzzzzzz')).status).toBe(404);
    expect((await request(app).get(`/${disabled.code}`)).status).toBe(410);

    await sleep(100);
    expect(await entries()).toHaveLength(0);
  });

  it('still redirects when the event cannot be written', async () => {
    const { code } = await makeLink();
    const xadd = vi.spyOn(redis, 'xadd').mockRejectedValue(new Error('redis is full'));

    const res = await request(app).get(`/${code}`);
    expect(res.status).toBe(302);
    expect(xadd).toHaveBeenCalledTimes(1);
  });

  it('does not try at all while Redis is disconnected', () => {
    const xadd = vi.spyOn(redis, 'xadd');
    const status = redis.status;
    redis.status = 'reconnecting';
    try {
      expect(recordClick({ code: 'abcdefg' })).toBe(false);
    } finally {
      redis.status = status;
    }
    expect(xadd).not.toHaveBeenCalled();
  });

  it('keeps the stream to a bounded length', async () => {
    analytics.maxLength = 100;
    for (let i = 0; i < 1000; i += 1) recordClick({ code: 'abcdefg' });
    await waitFor(async () => (await entries()).length > 0);
    await redis.ping();

    expect(await redis.xlen(analytics.streamKey)).toBeLessThan(400);
  });
});

describe('the click worker', () => {
  it('stores a batch, counts it per hour, and empties the stream', async () => {
    const { code, id } = await makeLink();
    for (let i = 0; i < 5; i += 1) await addEntry(event(code, { dev: i < 2 ? 'mobile' : 'desktop', ref: 't.co' }));

    const result = await worker.runOnce();

    expect(result).toEqual({ read: 5, recorded: 5, skipped: 0 });
    const rows = await clicksFor(id);
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.device === 'mobile')).toHaveLength(2);
    expect(rows.every((row) => row.referrer_host === 't.co')).toBe(true);
    expect((await statsFor(id)).map((row) => row.clicks)).toEqual([5]);
    expect(await redis.xlen(analytics.streamKey)).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it('counts clicks in the hour they happened', async () => {
    const { code, id } = await makeLink();
    const now = Date.now();
    await addEntry(event(code, { ts: String(now - 3 * hour) }));
    await addEntry(event(code, { ts: String(now - 3 * hour) }));
    await addEntry(event(code, { ts: String(now) }));

    await worker.runOnce();
    const stats = await statsFor(id);

    expect(stats.map((row) => row.clicks)).toEqual([2, 1]);
    for (const row of stats) expect(row.hour.getUTCMinutes()).toBe(0);
  });

  it('adds to the hourly count across batches', async () => {
    const { code, id } = await makeLink();
    await addEntry(event(code));
    await worker.runOnce();
    await addEntry(event(code));
    await addEntry(event(code));
    await worker.runOnce();

    expect((await statsFor(id)).map((row) => row.clicks)).toEqual([3]);
  });

  it('never counts the same event twice', async () => {
    const { code, id } = await makeLink();
    const events = [0, 1, 2].map(() => parseEntry(['0-0', Object.entries(event(code)).flat()]));

    expect(await recordClicks(events)).toBe(3);
    expect(await recordClicks(events)).toBe(0);
    expect(await recordClicks([...events, ...events])).toBe(0);

    expect(await clicksFor(id)).toHaveLength(3);
    expect((await statsFor(id)).map((row) => row.clicks)).toEqual([3]);
  });

  it('reprocesses a batch whose acknowledgement was lost, without counting it twice', async () => {
    const { code, id } = await makeLink();
    for (let i = 0; i < 3; i += 1) await addEntry(event(code));
    vi.spyOn(redis, 'multi').mockImplementationOnce(() => {
      throw new Error('connection lost before XACK');
    });

    await expect(worker.runOnce()).rejects.toThrow('connection lost');
    expect(await clicksFor(id)).toHaveLength(3);
    expect(await pendingCount()).toBe(3);

    analytics.claimIdleMs = 0;
    expect((await worker.runOnce()).read).toBe(3);
    expect(await clicksFor(id)).toHaveLength(3);
    expect((await statsFor(id)).map((row) => row.clicks)).toEqual([3]);
    expect(await pendingCount()).toBe(0);
  });

  it('keeps a batch pending when the database fails, and stores it once the database is back', async () => {
    const { code, id } = await makeLink();
    for (let i = 0; i < 4; i += 1) await addEntry(event(code));
    const realQuery = pool.query.bind(pool);
    vi.spyOn(pool, 'query').mockImplementation((text, params) =>
      String(text).includes('INSERT INTO clicks') ? Promise.reject(new Error('database down')) : realQuery(text, params)
    );

    await expect(worker.runOnce()).rejects.toThrow('database down');
    expect(await pendingCount()).toBe(4);
    expect(await clicksFor(id)).toHaveLength(0);

    vi.restoreAllMocks();
    analytics.claimIdleMs = 0;
    await worker.runOnce();
    expect(await clicksFor(id)).toHaveLength(4);
    expect(await redis.xlen(analytics.streamKey)).toBe(0);
  });

  it('takes over events from a worker that crashed', async () => {
    const { code, id } = await makeLink();
    for (let i = 0; i < 3; i += 1) await addEntry(event(code));
    await redis.xreadgroup('GROUP', analytics.group, 'crashed-worker', 'COUNT', 10, 'STREAMS', analytics.streamKey, '>');

    expect((await worker.runOnce()).read).toBe(0);

    analytics.claimIdleMs = 0;
    expect((await worker.runOnce()).read).toBe(3);
    expect(await clicksFor(id)).toHaveLength(3);
    expect(await pendingCount()).toBe(0);
  });

  it('drops entries it cannot understand, so they never block the stream', async () => {
    const { code, id } = await makeLink();
    await addEntry({ garbage: 'yes' });
    await addEntry(event(code, { id: 'not-a-uuid' }));
    await addEntry(event(code, { dev: 'toaster' }));
    await addEntry(event('bad code!'));
    await addEntry(event(code, { ts: 'yesterday' }));
    await addEntry(event(code, { ref: 'x'.repeat(300) }));
    await addEntry(event(code));

    expect(await worker.runOnce()).toEqual({ read: 7, recorded: 1, skipped: 6 });
    expect(await clicksFor(id)).toHaveLength(1);
    expect(await redis.xlen(analytics.streamKey)).toBe(0);
  });

  it('ignores events that are too old or in the future', async () => {
    const { code, id } = await makeLink();
    await addEntry(event(code, { ts: String(Date.now() - 365 * 24 * hour) }));
    await addEntry(event(code, { ts: String(Date.now() + 7 * 24 * hour) }));

    expect(await worker.runOnce()).toMatchObject({ read: 2, recorded: 0, skipped: 2 });
    expect(await clicksFor(id)).toHaveLength(0);
  });

  it('skips clicks on links that were deleted before the worker saw them', async () => {
    const { code } = await makeLink();
    await addEntry(event(code));
    await addEntry(event('nosuch1'));
    await request(app).delete(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`);

    expect(await worker.runOnce()).toEqual({ read: 2, recorded: 0, skipped: 0 });
    expect(await redis.xlen(analytics.streamKey)).toBe(0);
  });

  it('removes the clicks and counts of a deleted link', async () => {
    const { code, id } = await makeLink();
    await addEntry(event(code));
    await worker.runOnce();
    await request(app).delete(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`);

    expect(await clicksFor(id)).toHaveLength(0);
    expect(await statsFor(id)).toHaveLength(0);
  });

  it('can create its group twice', async () => {
    await expect(worker.ensureGroup()).resolves.toBeUndefined();
  });

  it('runs on its own connection from redirect to database, and stops cleanly', async () => {
    analytics.blockMs = 200;
    const connection = createRedisConnection('Test worker');
    const running = createClickWorker({ redis: connection, consumer: 'running-worker' });
    const { code, id } = await makeLink();

    await running.start();
    for (let i = 0; i < 3; i += 1) await request(app).get(`/${code}`).set('User-Agent', IPHONE);

    expect(await waitFor(async () => (await clicksFor(id)).length === 3, 5000)).toBe(true);
    const started = Date.now();
    await running.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    await connection.quit();

    expect((await clicksFor(id)).every((row) => row.device === 'mobile')).toBe(true);
  });
});

describe('monthly partitions', () => {
  it('creates a month partition once, and can be asked again', async () => {
    const at = new Date('2030-05-17T12:00:00Z');
    expect(await ensureClickPartition(at)).toBe('clicks_2030_05');
    expect(await ensureClickPartition(at)).toBe('clicks_2030_05');
    expect(await listClickPartitions()).toContain('clicks_2030_05');
  });

  it('uses UTC month boundaries', async () => {
    expect(await ensureClickPartition(new Date('2030-06-30T23:59:59Z'))).toBe('clicks_2030_06');
    expect(await ensureClickPartition(new Date('2030-07-01T00:00:00Z'))).toBe('clicks_2030_07');
  });

  it('creates the partition an event needs on its own', async () => {
    const { code, id } = await makeLink();
    const at = new Date('2030-09-09T09:00:00Z');
    expect(await listClickPartitions()).not.toContain('clicks_2030_09');

    await recordClicks([{ id: randomUUID(), code, clickedAt: at, referrerHost: null, device: 'other' }]);

    expect(await listClickPartitions()).toContain('clicks_2030_09');
    expect((await query('SELECT count(*)::int AS n FROM clicks_2030_09 WHERE link_id = $1', [id])).rows[0].n).toBe(1);
  });

  it('recovers when a partition it already knew disappears', async () => {
    const { code } = await makeLink();
    const at = new Date('2031-01-15T00:00:00Z');
    const click = () => recordClicks([{ id: randomUUID(), code, clickedAt: at, referrerHost: null, device: 'other' }]);
    await click();
    await query('DROP TABLE clicks_2031_01');

    await expect(click()).rejects.toMatchObject({ code: '23514' });
    expect(await click()).toBe(1);
  });

  it('drops whole months past the retention period, and keeps the rest', async () => {
    await ensureClickPartition(new Date('2020-01-10T00:00:00Z'));
    await ensureClickPartition(new Date('2020-02-10T00:00:00Z'));
    const current = `clicks_${new Date().toISOString().slice(0, 7).replace('-', '_')}`;

    const dropped = await dropOldClickPartitions(6);

    expect(dropped).toEqual(expect.arrayContaining(['clicks_2020_01', 'clicks_2020_02']));
    const remaining = await listClickPartitions();
    expect(remaining).not.toContain('clicks_2020_01');
    expect(remaining).toContain(current);
  });

  it('keeps exactly the configured number of months', async () => {
    await ensureClickPartition(new Date('2020-03-10T00:00:00Z'));
    await ensureClickPartition(new Date('2020-04-10T00:00:00Z'));
    const dropped = await dropOldClickPartitions(2, new Date('2020-04-20T00:00:00Z'));

    expect(dropped).not.toContain('clicks_2020_03');
    expect(dropped).not.toContain('clicks_2020_04');
    expect(await dropOldClickPartitions(1, new Date('2020-04-20T00:00:00Z'))).toContain('clicks_2020_03');
  });
});
