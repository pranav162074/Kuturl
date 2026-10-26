import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import rateLimits from '../src/config/rateLimits.js';
import settings from '../src/config/linkFilter.js';
import { reserveLinkId, insertLink } from '../src/db/links.js';
import codes from '../src/services/codes.js';
import linkFilter from '../src/services/linkFilter.js';
import { resetBreaker } from '../src/services/linkCache.js';
import { resetRateLimiterBreaker } from '../src/services/rateLimiter.js';
import { MAX_BULK_LINKS } from '../src/utils/validators.js';

const originalPolicies = structuredClone(rateLimits.policies);
const keyIds = [];
const touched = new Set();
const stamp = Date.now().toString(36);

const makeKey = async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'bulk test' });
  keyIds.push(res.body.id);
  return { id: res.body.id, apiKey: res.body.apiKey };
};

const bulk = (apiKey, body, headers = {}) =>
  request(app)
    .post('/api/v1/links/bulk')
    .set('Authorization', `Bearer ${apiKey}`)
    .set(headers)
    .send(body)
    .then((res) => {
      for (const result of res.body.results ?? []) if (result.code) touched.add(result.code);
      return res;
    });

const linkCount = async (apiKeyId) =>
  (await query('SELECT count(*)::int AS n FROM links WHERE api_key_id = $1', [apiKeyId])).rows[0].n;

const urls = (count, prefix = 'bulk') => Array.from({ length: count }, (_, i) => ({ url: `https://example.com/${prefix}/${i}` }));

beforeAll(() => {
  rateLimits.enabled = false;
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetBreaker();
  resetRateLimiterBreaker();
  rateLimits.enabled = false;
  rateLimits.policies = structuredClone(originalPolicies);
  await linkFilter.stop();
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (touched.size > 0) await redis.del(...[...touched].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('bulk creation', () => {
  it('needs an API key', async () => {
    expect((await request(app).post('/api/v1/links/bulk').send({ links: urls(1) })).status).toBe(401);
  });

  it('creates every link, in order, and each one redirects', async () => {
    const { id, apiKey } = await makeKey();
    const alias = `bulk-${stamp}`;
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await bulk(apiKey, {
      links: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b', alias }, { url: 'https://example.com/c', expiresAt }],
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(res.body.results.every((r) => r.status === 201)).toBe(true);
    expect(res.body.results[1].code).toBe(alias);
    expect(res.body.results[2].expiresAt).toBe(expiresAt);
    expect(Object.keys(res.body.results[0]).sort()).toEqual(['code', 'createdAt', 'expiresAt', 'index', 'longUrl', 'shortUrl', 'status']);
    expect(await linkCount(id)).toBe(3);

    for (const [i, result] of res.body.results.entries()) {
      const followed = await request(app).get(`/${result.code}`);
      expect(followed.status).toBe(302);
      expect(followed.headers.location).toBe(`https://example.com/${'abc'[i]}`);
    }
  });

  it('uses one id query and one insert for the whole batch', async () => {
    const { apiKey } = await makeKey();
    const spy = vi.spyOn(pool, 'query');

    const res = await bulk(apiKey, { links: urls(50) });

    expect(res.status).toBe(201);
    const statements = spy.mock.calls.map(([text]) => String(text));
    expect(statements.filter((text) => text.includes('INSERT INTO links'))).toHaveLength(1);
    expect(statements.filter((text) => text.includes("nextval('links_id_seq')"))).toHaveLength(1);
    expect(new Set(res.body.results.map((r) => r.code)).size).toBe(50);
  });

  it('accepts the maximum batch of 100, even with long URLs', async () => {
    const { id, apiKey } = await makeKey();
    const long = Array.from({ length: MAX_BULK_LINKS }, (_, i) => ({ url: `https://example.com/${i}/${'x'.repeat(1990)}` }));

    const res = await bulk(apiKey, { links: long });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(100);
    expect(await linkCount(id)).toBe(100);
  });

  it('reports each failure with its index, and still creates the rest', async () => {
    const { id, apiKey } = await makeKey();
    const existing = `owned-${stamp}`;
    touched.add(existing);
    await bulk(apiKey, { links: [{ url: 'https://example.com/first', alias: existing }] });
    const twice = `twice-${stamp}`;

    const res = await bulk(apiKey, {
      links: [
        { url: 'https://example.com/ok-1' },
        { url: 'notaurl' },
        { url: 'https://example.com/reserved', alias: 'admin' },
        { url: 'https://example.com/taken', alias: existing },
        { url: 'https://example.com/twice-1', alias: twice },
        { url: 'https://example.com/twice-2', alias: twice.toUpperCase() },
        { url: 'http://localhost/private' },
        { url: 'https://example.com/ok-2', extra: true },
        'https://example.com/not-an-object',
        { url: 'https://example.com/ok-3' },
      ],
    });

    expect(res.status).toBe(207);
    expect(res.body.created).toBe(3);
    expect(res.body.failed).toBe(7);
    const byIndex = Object.fromEntries(res.body.results.map((r) => [r.index, r]));
    expect([byIndex[0].status, byIndex[4].status, byIndex[9].status]).toEqual([201, 201, 201]);
    expect(byIndex[1]).toMatchObject({ status: 400, error: 'validation_error', message: 'Enter a full URL starting with http:// or https://' });
    expect(byIndex[2]).toMatchObject({ status: 400, message: 'That alias is reserved, please choose another' });
    expect(byIndex[3]).toMatchObject({ status: 409, error: 'alias_taken', message: 'That alias is already taken' });
    expect(byIndex[5]).toMatchObject({ status: 409, error: 'alias_taken', message: 'That alias appears more than once in this request' });
    expect(byIndex[6]).toMatchObject({ status: 400, message: 'Links to private or internal addresses are not allowed' });
    expect(byIndex[7]).toMatchObject({ status: 400 });
    expect(byIndex[8]).toMatchObject({ status: 400 });
    expect(byIndex[1].details[0].field).toBe('url');
    expect(await linkCount(id)).toBe(1 + 3);
  });

  it('answers 207 with nothing created when every item fails', async () => {
    const { id, apiKey } = await makeKey();
    const res = await bulk(apiKey, { links: [{ url: 'nope' }, { url: 'ftp://example.com' }] });
    expect(res.status).toBe(207);
    expect(res.body).toMatchObject({ created: 0, failed: 2 });
    expect(await linkCount(id)).toBe(0);
  });

  it('rejects a request that is not a batch of 1 to 100 links', async () => {
    const { apiKey } = await makeKey();
    const cases = [
      [{}, 'links must be an array'],
      [{ links: 'x' }, 'links must be an array'],
      [{ links: [] }, 'links must contain at least one link'],
      [{ links: urls(101) }, 'links can contain at most 100 links'],
    ];
    for (const [body, message] of cases) {
      const res = await bulk(apiKey, body);
      expect(res.status, message).toBe(400);
      expect(res.body.message).toBe(message);
    }
    expect((await bulk(apiKey, { links: urls(1), other: 1 })).status).toBe(400);
  });

  it('moves a generated code on when it equals an existing alias', async () => {
    const { id: keyId, apiKey } = await makeKey();
    const reserved = BigInt(await reserveLinkId());
    const planted = codes.encode(reserved + 1n);
    touched.add(planted);
    await insertLink({ id: reserved, code: planted, longUrl: 'https://example.com/planted', apiKeyId: keyId, isCustom: true });

    const res = await bulk(apiKey, { links: [{ url: 'https://example.com/real' }] });

    expect(res.status).toBe(201);
    expect(res.body.results[0].code).not.toBe(planted);
    expect(res.body.results[0].code).toBe(codes.encode(reserved + 2n));
  });

  it('makes a new alias work at once, even after a 404 for it was cached', async () => {
    const { apiKey } = await makeKey();
    const alias = `soon-bulk-${stamp}`;
    touched.add(alias);
    expect((await request(app).get(`/${alias}`)).status).toBe(404);

    await bulk(apiKey, { links: [{ url: 'https://example.com/soon', alias }] });

    expect((await request(app).get(`/${alias}`)).status).toBe(302);
  });

  it('charges one rate limit token per link in the batch', async () => {
    const { apiKey } = await makeKey();
    rateLimits.enabled = true;
    rateLimits.policies.linkCreation = { capacity: 10, refillPerSecond: 0.001, failOpen: true };
    const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

    const first = await bulk(apiKey, { links: urls(8) }, { 'X-Forwarded-For': ip });
    expect(first.status).toBe(201);
    expect(first.headers['ratelimit-remaining']).toBe('2');

    const second = await bulk(apiKey, { links: urls(3) }, { 'X-Forwarded-For': ip });
    expect(second.status).toBe(429);

    const single = await request(app)
      .post('/api/v1/links')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-Forwarded-For', ip)
      .send({ url: 'https://example.com/one-more' });
    expect(single.status).toBe(201);
    touched.add(single.body.code);
  });

  it('always lets a full batch fit in the link creation bucket', () => {
    expect(rateLimits.policies.linkCreation.capacity).toBeGreaterThanOrEqual(MAX_BULK_LINKS);
  });

  it('replays the whole batch for a repeated Idempotency-Key', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const body = { links: urls(5, 'idem') };

    const first = await bulk(apiKey, body, { 'Idempotency-Key': key });
    const again = await bulk(apiKey, body, { 'Idempotency-Key': key });
    const other = await bulk(apiKey, { links: urls(4, 'idem') }, { 'Idempotency-Key': key });

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(other.status).toBe(422);
    expect(await linkCount(id)).toBe(5);
  });

  it('announces the whole batch to other instances in one message', async () => {
    const { apiKey } = await makeKey();
    await linkFilter.start();
    const publish = vi.spyOn(redis, 'publish');

    const res = await bulk(apiKey, { links: urls(20, 'announce') });

    const created = res.body.results.map((r) => r.code);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe(settings.channel);
    expect(publish.mock.calls[0][1].split(',').sort()).toEqual([...created].sort());
    expect(created.every((code) => linkFilter.mightExist(code))).toBe(true);
  });

  it('counts created and failed items', async () => {
    const { apiKey } = await makeKey();
    const read = async (outcome) => {
      const text = (await request(app).get('/metrics')).text;
      const line = text.split('\n').find((l) => l.startsWith(`kuturl_bulk_link_items_total{outcome="${outcome}"}`));
      return line ? Number(line.split(' ').at(-1)) : 0;
    };
    const created = await read('created');
    const failed = await read('failed');

    await bulk(apiKey, { links: [{ url: 'https://example.com/m1' }, { url: 'bad' }, { url: 'https://example.com/m2' }] });

    expect((await read('created')) - created).toBe(2);
    expect((await read('failed')) - failed).toBe(1);
  });
});
