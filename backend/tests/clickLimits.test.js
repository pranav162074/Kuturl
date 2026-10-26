import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { resetBreaker } from '../src/services/linkCache.js';
import { counterKey, markLimitReached } from '../src/services/clickLimits.js';
import { toShortUrl } from '../src/services/links.js';

const keyIds = [];
const touched = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let apiKey;
let apiKeyId;

const create = async (body) => {
  const res = await request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send(body);
  if (res.body.code) touched.add(res.body.code);
  return res;
};

const limited = async (maxClicks, extra = {}) => (await create({ url: 'https://example.com/limited', maxClicks, ...extra })).body.code;

const linkRow = async (code) => (await query('SELECT * FROM links WHERE code = $1', [code])).rows[0];

const details = (code) => request(app).get(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`);

const waitFor = async (check, timeoutMs = 2000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
};

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'click limit test' });
  apiKey = res.body.apiKey;
  apiKeyId = res.body.id;
  keyIds.push(apiKeyId);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
});

afterAll(async () => {
  const ids = (await query('SELECT id FROM links WHERE api_key_id = ANY($1::bigint[])', [keyIds])).rows.map((r) => counterKey(r.id));
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  const keys = [...[...touched].map((code) => `link:${code}`), ...ids];
  if (keys.length > 0) await redis.del(...keys);
  await closePool();
  await redis.quit();
});

describe('setting a click limit', () => {
  it('is shown in the link details', async () => {
    const code = await limited(3);
    const res = await details(code);
    expect(res.body).toMatchObject({ maxClicks: 3, clickLimitReachedAt: null, status: 'active' });

    const plain = (await create({ url: 'https://example.com/unlimited' })).body.code;
    expect((await details(plain)).body.maxClicks).toBeNull();
  });

  it('must be a whole number from 1 to a billion', async () => {
    for (const [maxClicks, message] of [
      [0, 'maxClicks must be at least 1'],
      [1.5, 'maxClicks must be a whole number'],
      ['10', 'maxClicks must be a number'],
      [1_000_000_001, 'maxClicks must be at most 1000000000'],
    ]) {
      const res = await create({ url: 'https://example.com/x', maxClicks });
      expect(res.status, String(maxClicks)).toBe(400);
      expect(res.body.message).toBe(message);
    }
  });
});

describe('enforcing a click limit', () => {
  it('redirects up to the limit, then answers 410', async () => {
    const code = await limited(3);
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await request(app).get(`/${code}`)).status);

    expect(statuses).toEqual([302, 302, 302, 410, 410]);
    const last = await request(app).get(`/${code}`).set('Accept', 'application/json');
    expect(last.body.error).toBe('link_click_limit_reached');
  });

  it('lets exactly the limit through when many visitors arrive at once', async () => {
    const code = await limited(10);
    const results = await Promise.all(Array.from({ length: 50 }, () => request(app).get(`/${code}`)));

    expect(results.filter((res) => res.status === 302)).toHaveLength(10);
    expect(results.filter((res) => res.status === 410)).toHaveLength(40);
  });

  it('records the moment the limit was reached, and stops counting', async () => {
    const code = await limited(2);
    await request(app).get(`/${code}`);
    await request(app).get(`/${code}`);

    expect(await waitFor(async () => (await linkRow(code)).limit_reached_at !== null)).toBe(true);
    expect((await details(code)).body.status).toBe('click_limit_reached');
    expect(JSON.parse(await redis.get(`link:${code}`))).toEqual({ s: 'exhausted' });

    const counter = vi.spyOn(redis, 'clickLimit');
    const res = await request(app).get(`/${code}`);
    expect(res.status).toBe(410);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(counter).not.toHaveBeenCalled();
  });

  it('never touches the counter for links without a limit', async () => {
    const code = (await create({ url: 'https://example.com/free' })).body.code;
    const counter = vi.spyOn(redis, 'clickLimit');
    for (let i = 0; i < 3; i += 1) expect((await request(app).get(`/${code}`)).status).toBe(302);
    expect(counter).not.toHaveBeenCalled();
  });

  it('does not count HEAD requests or prefetches', async () => {
    const code = await limited(1);
    await request(app).head(`/${code}`);
    await request(app).get(`/${code}`).set('Sec-Purpose', 'prefetch');
    expect((await request(app).get(`/${code}`)).status).toBe(302);
    expect((await request(app).get(`/${code}`)).status).toBe(410);
  });

  it('rebuilds a lost counter from the recorded clicks', async () => {
    const code = await limited(5);
    const link = await linkRow(code);
    await query(`INSERT INTO link_stats_hourly (link_id, hour, clicks) VALUES ($1, date_trunc('hour', now()), 4)`, [link.id]);
    await redis.del(counterKey(link.id));

    expect((await request(app).get(`/${code}`)).status).toBe(302);
    expect((await request(app).get(`/${code}`)).status).toBe(410);
    expect(await redis.get(counterKey(link.id))).toBe('6');
  });

  it('refuses limited links while the counter is unreachable, and serves the rest', async () => {
    const code = await limited(5);
    const free = (await create({ url: 'https://example.com/free-2' })).body.code;
    vi.spyOn(redis, 'clickLimit').mockRejectedValue(new Error('redis is down'));

    expect((await request(app).get(`/${code}`)).status).toBe(503);
    expect((await request(app).get(`/${free}`)).status).toBe(302);
  });

  it('can raise or remove the limit, which reopens the link', async () => {
    const code = await limited(1);
    await request(app).get(`/${code}`);
    expect((await request(app).get(`/${code}`)).status).toBe(410);
    await waitFor(async () => (await linkRow(code)).limit_reached_at !== null);

    const raised = await request(app).patch(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`).send({ maxClicks: 3 });
    expect(raised.body).toMatchObject({ maxClicks: 3, clickLimitReachedAt: null, status: 'active' });
    expect((await request(app).get(`/${code}`)).status).toBe(302);
    expect((await request(app).get(`/${code}`)).status).toBe(410);

    await request(app).patch(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`).send({ maxClicks: null });
    for (let i = 0; i < 3; i += 1) expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('forgets the counter when the link is deleted', async () => {
    const code = await limited(5);
    const link = await linkRow(code);
    await request(app).get(`/${code}`);
    expect(await redis.exists(counterKey(link.id))).toBe(1);

    await request(app).delete(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`);
    expect(await redis.exists(counterKey(link.id))).toBe(0);
  });

  it('counts a password-protected link only when it is unlocked', async () => {
    const code = await limited(1, { password: 'secret pass' });
    expect((await request(app).get(`/${code}`)).status).toBe(403);

    const unlock = () => request(app).post(`/${code}/unlock`).set('Accept', 'application/json').send({ password: 'secret pass' });
    expect((await unlock()).status).toBe(302);
    expect((await unlock()).status).toBe(410);
  });

  it('works for links created in bulk', async () => {
    const res = await request(app)
      .post('/api/v1/links/bulk')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ links: [{ url: 'https://example.com/bulk-limited', maxClicks: 1 }] });
    const { code } = res.body.results[0];
    touched.add(code);
    expect((await request(app).get(`/${code}`)).status).toBe(302);
    expect((await request(app).get(`/${code}`)).status).toBe(410);
  });
});

describe('reaching the limit', () => {
  it('queues exactly one event, however many visitors cross the limit at once', async () => {
    const endpoint = await request(app)
      .post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: 'https://hooks.example.com/kuturl' });
    expect(endpoint.status).toBe(201);
    const code = await limited(5);

    await Promise.all(Array.from({ length: 30 }, () => request(app).get(`/${code}`)));
    await waitFor(async () => (await linkRow(code)).limit_reached_at !== null);
    await sleep(100);

    const { rows } = await query(
      `SELECT payload FROM webhook_deliveries WHERE endpoint_id = $1 AND event_type = 'link.click_limit_reached'`,
      [endpoint.body.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.data.link).toMatchObject({ code, maxClicks: 5, longUrl: 'https://example.com/limited' });
  });

  it('marks the link and queues the event together, or not at all', async () => {
    const code = await limited(1);
    const link = await linkRow(code);
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await connect();
      const original = client.query.bind(client);
      client.query = (text, params) =>
        String(text).includes('INSERT INTO webhook_deliveries') ? Promise.reject(new Error('outbox write failed')) : original(text, params);
      client.release = ((release) => () => {
        client.query = original;
        release();
      })(client.release.bind(client));
      return client;
    });

    await expect(markLimitReached(link.id, toShortUrl)).rejects.toThrow('outbox write failed');
    vi.restoreAllMocks();
    expect((await linkRow(code)).limit_reached_at).toBeNull();

    expect(await markLimitReached(link.id, toShortUrl)).toBe(true);
    expect((await linkRow(code)).limit_reached_at).not.toBeNull();
    expect(await markLimitReached(link.id, toShortUrl)).toBe(false);
  });
});
