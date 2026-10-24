import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { recordClicks } from '../src/db/clicks.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const keyIds = [];
const codes = new Set();

let owner;
let stranger;

const makeKey = async (name) => {
  const res = await request(app).post('/api/v1/keys').send({ name });
  keyIds.push(res.body.id);
  return res.body.apiKey;
};

const makeLink = async () => {
  const res = await request(app)
    .post('/api/v1/links')
    .set('Authorization', `Bearer ${owner}`)
    .send({ url: 'https://example.com/stats' });
  codes.add(res.body.code);
  return res.body.code;
};

const click = (code, at, { ref = null, dev = 'desktop' } = {}) =>
  recordClicks([{ id: randomUUID(), code, clickedAt: new Date(at), referrerHost: ref, device: dev }]);

const stats = (code, path = '', apiKey = owner) =>
  request(app).get(`/api/v1/links/${code}/stats${path}`).set('Authorization', `Bearer ${apiKey}`);

beforeAll(async () => {
  owner = await makeKey('stats owner');
  stranger = await makeKey('stats stranger');
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('access', () => {
  const paths = ['', '/timeseries', '/referrers', '/devices'];

  it('needs an API key', async () => {
    const code = await makeLink();
    for (const path of paths) {
      expect((await request(app).get(`/api/v1/links/${code}/stats${path}`)).status, path).toBe(401);
    }
  });

  it('answers 404 for links owned by someone else, unknown links and malformed codes', async () => {
    const code = await makeLink();
    for (const path of paths) {
      expect((await stats(code, path, stranger)).status, path).toBe(404);
      expect((await stats('zzzzzzz', path)).status, path).toBe(404);
      expect((await stats('not.a.code', path)).status, path).toBe(404);
    }
  });
});

describe('summary', () => {
  it('starts at zero', async () => {
    const res = await stats(await makeLink());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalClicks: 0,
      last24Hours: 0,
      last7Days: 0,
      last30Days: 0,
      lastClickAt: null,
      timezone: 'UTC',
    });
  });

  it('counts clicks over rolling windows', async () => {
    const code = await makeLink();
    const now = Date.now();
    await click(code, now - 5 * 60 * 1000);
    await click(code, now - 2 * DAY);
    await click(code, now - 10 * DAY);
    await click(code, now - 40 * DAY);

    const res = await stats(code);
    expect(res.body).toMatchObject({ code, totalClicks: 4, last24Hours: 1, last7Days: 2, last30Days: 3 });
    expect(new Date(res.body.lastClickAt).getTime()).toBeGreaterThan(now - 10 * 60 * 1000);
  });

  it('keeps counting clicks whose raw rows are gone, from the hourly totals', async () => {
    const code = await makeLink();
    const { rows } = await query('SELECT id FROM links WHERE code = $1', [code]);
    await query(`INSERT INTO link_stats_hourly (link_id, hour, clicks) VALUES ($1, '2024-03-01T10:00:00Z', 7)`, [rows[0].id]);

    const res = await stats(code);
    expect(res.body.totalClicks).toBe(7);
    expect(res.body.last30Days).toBe(0);
    expect(res.body.lastClickAt).toBeNull();
  });
});

describe('time series', () => {
  it('defaults to the last 30 days, one point per UTC day, with empty days as zero', async () => {
    const code = await makeLink();
    const now = Date.now();
    await click(code, now);
    await click(code, now);
    await click(code, now - 3 * DAY);

    const res = await stats(code, '/timeseries');
    const { points } = res.body;

    expect(res.status).toBe(200);
    expect(res.body.interval).toBe('day');
    expect(points).toHaveLength(30);
    expect(res.body.totalClicks).toBe(3);
    expect(points.at(-1).clicks).toBe(2);
    expect(points.at(-4).clicks).toBe(1);
    expect(points.filter((point) => point.clicks === 0)).toHaveLength(28);
    for (const point of points) expect(point.at).toMatch(/T00:00:00\.000Z$/);
    expect(new Date(points.at(-1).at).toISOString().slice(0, 10)).toBe(new Date(now).toISOString().slice(0, 10));
  });

  it('defaults to the last 24 hours for hourly points', async () => {
    const res = await stats(await makeLink(), '/timeseries?interval=hour');
    expect(res.body.points).toHaveLength(24);
    for (const point of res.body.points) expect(point.at).toMatch(/:00:00\.000Z$/);
  });

  it('puts each click in the hour it happened, within the requested range', async () => {
    const code = await makeLink();
    await click(code, '2026-08-10T09:05:00Z');
    await click(code, '2026-08-10T09:55:00Z');
    await click(code, '2026-08-10T11:00:00Z');
    await click(code, '2026-08-10T12:00:00Z');

    const res = await stats(code, '/timeseries?interval=hour&from=2026-08-10T09:30:00Z&to=2026-08-10T12:00:00Z');

    expect(res.body.from).toBe('2026-08-10T09:00:00.000Z');
    expect(res.body.to).toBe('2026-08-10T12:00:00.000Z');
    expect(res.body.points).toEqual([
      { at: '2026-08-10T09:00:00.000Z', clicks: 2 },
      { at: '2026-08-10T10:00:00.000Z', clicks: 0 },
      { at: '2026-08-10T11:00:00.000Z', clicks: 1 },
    ]);
  });

  it('splits days at midnight UTC', async () => {
    const code = await makeLink();
    await click(code, '2026-08-20T23:30:00Z');
    await click(code, '2026-08-21T00:30:00Z');

    const res = await stats(code, '/timeseries?from=2026-08-20T00:00:00Z&to=2026-08-22T00:00:00Z');
    expect(res.body.points).toEqual([
      { at: '2026-08-20T00:00:00.000Z', clicks: 1 },
      { at: '2026-08-21T00:00:00.000Z', clicks: 1 },
    ]);
  });

  it('accepts offsets and reports the range in UTC', async () => {
    const res = await stats(await makeLink(), '/timeseries?interval=hour&from=2026-08-10T05:30:00%2B05:30&to=2026-08-10T07:30:00%2B05:30');
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-08-10T00:00:00.000Z');
    expect(res.body.points).toHaveLength(2);
  });

  it('allows up to 744 hours or 366 days', async () => {
    const code = await makeLink();
    expect((await stats(code, '/timeseries?interval=hour&from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z')).body.points).toHaveLength(744);
    expect((await stats(code, '/timeseries?from=2025-01-01T00:00:00Z&to=2026-01-02T00:00:00Z')).body.points).toHaveLength(366);

    expect((await stats(code, '/timeseries?interval=hour&from=2026-07-01T00:00:00Z&to=2026-08-01T01:00:00Z')).status).toBe(400);
    expect((await stats(code, '/timeseries?from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z')).status).toBe(400);
  });

  it('rejects ranges and parameters that make no sense', async () => {
    const code = await makeLink();
    const cases = [
      ['?interval=minute', 'interval must be hour or day'],
      ['?from=2026-08-10T00:00:00Z&to=2026-08-09T00:00:00Z', 'from must be before to'],
      ['?from=2026-08-10T00:00:00Z&to=2026-08-10T00:00:00Z', 'from must be before to'],
      ['?from=yesterday', 'from must be an ISO 8601 date-time, for example 2027-01-31T12:00:00Z'],
      ['?from=2026-08-10', 'from must be an ISO 8601 date-time, for example 2027-01-31T12:00:00Z'],
    ];
    for (const [path, message] of cases) {
      const res = await stats(code, `/timeseries${path}`);
      expect(res.status, path).toBe(400);
      expect(res.body.message, path).toBe(message);
    }
    expect((await stats(code, '/timeseries?unknown=1')).status).toBe(400);
    expect((await stats(code, '/timeseries?interval=day&interval=hour')).status).toBe(400);
  });
});

describe('referrers', () => {
  it('ranks referrers by clicks, counts direct visits as null, and respects the limit', async () => {
    const code = await makeLink();
    const now = Date.now();
    for (const ref of ['t.co', 't.co', 't.co', 'google.com', 'google.com', null, 'reddit.com']) {
      await click(code, now - HOUR, { ref });
    }

    const res = await stats(code, '/referrers');
    expect(res.body.referrers).toEqual([
      { host: 't.co', clicks: 3 },
      { host: 'google.com', clicks: 2 },
      { host: 'reddit.com', clicks: 1 },
      { host: null, clicks: 1 },
    ]);

    const limited = await stats(code, '/referrers?limit=2');
    expect(limited.body.referrers.map((r) => r.host)).toEqual(['t.co', 'google.com']);
  });

  it('only counts clicks inside the range, which defaults to 30 days', async () => {
    const code = await makeLink();
    const now = Date.now();
    await click(code, now - DAY, { ref: 'recent.com' });
    await click(code, now - 40 * DAY, { ref: 'old.com' });

    expect((await stats(code, '/referrers')).body.referrers).toEqual([{ host: 'recent.com', clicks: 1 }]);

    const from = new Date(now - 45 * DAY).toISOString();
    const to = new Date(now - 35 * DAY).toISOString();
    const res = await stats(code, `/referrers?from=${from}&to=${to}`);
    expect(res.body.referrers).toEqual([{ host: 'old.com', clicks: 1 }]);
  });

  it('rejects a bad limit or a range over 186 days', async () => {
    const code = await makeLink();
    for (const path of ['?limit=0', '?limit=51', '?limit=abc', '?from=2025-01-01T00:00:00Z&to=2025-07-07T00:00:00Z']) {
      expect((await stats(code, `/referrers${path}`)).status, path).toBe(400);
    }
    expect((await stats(code, '/referrers?from=2025-01-01T00:00:00Z&to=2025-07-06T00:00:00Z')).status).toBe(200);
  });
});

describe('devices', () => {
  it('always lists every device class', async () => {
    const res = await stats(await makeLink(), '/devices');
    expect(res.body.devices).toEqual({ desktop: 0, mobile: 0, tablet: 0, bot: 0, other: 0 });
    expect(res.body.totalClicks).toBe(0);
  });

  it('counts clicks per device class inside the range', async () => {
    const code = await makeLink();
    const now = Date.now();
    for (const dev of ['mobile', 'mobile', 'desktop', 'bot']) await click(code, now - HOUR, { dev });
    await click(code, now - 60 * DAY, { dev: 'tablet' });

    const res = await stats(code, '/devices');
    expect(res.body.devices).toEqual({ desktop: 1, mobile: 2, tablet: 0, bot: 1, other: 0 });
    expect(res.body.totalClicks).toBe(4);
  });

  it('does not accept a limit', async () => {
    expect((await stats(await makeLink(), '/devices?limit=5')).status).toBe(400);
  });
});
