import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import {
  claimIdempotencyKey,
  findIdempotencyKey,
  saveIdempotentResponse,
  releaseIdempotencyKey,
  deleteExpiredIdempotencyKeys,
} from '../src/db/idempotencyKeys.js';
import { canonicalJson, hashRequest } from '../src/utils/requestHash.js';

const keyIds = [];
const codes = new Set();
const LINKS_PATH = '/api/v1/links/';

const makeKey = async (name = 'idempotency test') => {
  const res = await request(app).post('/api/v1/keys').send({ name });
  keyIds.push(res.body.id);
  return { id: res.body.id, apiKey: res.body.apiKey };
};

const create = (apiKey, body, idempotencyKey) => {
  const req = request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`);
  if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body).then((res) => {
    if (res.body?.code) codes.add(res.body.code);
    return res;
  });
};

const linkCount = async (apiKeyId) =>
  (await query('SELECT count(*)::int AS n FROM links WHERE api_key_id = $1', [apiKeyId])).rows[0].n;

const rowFor = async (apiKeyId, key) =>
  (await query('SELECT * FROM idempotency_keys WHERE api_key_id = $1 AND key = $2', [apiKeyId, key])).rows[0];

const plant = (apiKeyId, key, requestHash, extra = '') =>
  query(
    `INSERT INTO idempotency_keys (api_key_id, key, request_hash, lock_token${extra ? ', locked_at' : ''})
     VALUES ($1, $2, $3, $4${extra ? `, ${extra}` : ''})`,
    [apiKeyId, key, requestHash, randomUUID()]
  );

const hashOf = (body) => hashRequest('POST', LINKS_PATH, body);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('request fingerprint', () => {
  it('ignores the order of fields', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 })
    );
  });

  it('keeps the order of array items', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('writes dates the way JSON does', () => {
    expect(canonicalJson({ at: new Date('2030-01-01T00:00:00Z') })).toBe('{"at":"2030-01-01T00:00:00.000Z"}');
  });

  it('includes the method and the path', () => {
    const body = { url: 'https://example.com' };
    expect(hashRequest('POST', '/a', body)).not.toBe(hashRequest('POST', '/b', body));
    expect(hashRequest('POST', '/a', body)).not.toBe(hashRequest('PUT', '/a', body));
    expect(hashRequest('POST', '/a', body)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('creating links with an Idempotency-Key', () => {
  it('changes nothing for requests without the header', async () => {
    const { id, apiKey } = await makeKey();
    const first = await create(apiKey, { url: 'https://example.com/plain' });
    const second = await create(apiKey, { url: 'https://example.com/plain' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.code).not.toBe(first.body.code);
    expect(await linkCount(id)).toBe(2);
  });

  it('replays the first response for a repeated request, and creates one link', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const body = { url: 'https://example.com/once' };

    const first = await create(apiKey, body, key);
    const second = await create(apiKey, body, key);
    const third = await create(apiKey, body, key);

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    for (const res of [second, third]) {
      expect(res.status).toBe(201);
      expect(res.headers['idempotent-replayed']).toBe('true');
      expect(res.text).toBe(first.text);
    }
    expect(await linkCount(id)).toBe(1);
  });

  it('stores the finished response', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const res = await create(apiKey, { url: 'https://example.com/stored' }, key);
    const row = await rowFor(id, key);

    expect(row.status).toBe('done');
    expect(row.response_status).toBe(201);
    expect(row.response_body).toEqual(res.body);
  });

  it('treats the same fields in a different order as the same request', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    await create(apiKey, { url: 'https://example.com/order', expiresAt }, key);
    const again = await create(apiKey, { expiresAt, url: 'https://example.com/order' }, key);

    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await linkCount(id)).toBe(1);
  });

  it('compares requests after they are cleaned up', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();

    await create(apiKey, { url: 'https://EXAMPLE.com/clean' }, key);
    const again = await create(apiKey, { url: '  https://example.com/clean  ' }, key);

    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await linkCount(id)).toBe(1);
  });

  it('refuses a key reused with a different request, and keeps the original', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();

    const first = await create(apiKey, { url: 'https://example.com/first' }, key);
    const other = await create(apiKey, { url: 'https://example.com/second' }, key);

    expect(other.status).toBe(422);
    expect(other.body.error).toBe('idempotency_key_reused');
    expect(await linkCount(id)).toBe(1);

    const replay = await create(apiKey, { url: 'https://example.com/first' }, key);
    expect(replay.body.code).toBe(first.body.code);
  });

  it('keeps keys separate per API key', async () => {
    const first = await makeKey();
    const second = await makeKey();
    const key = randomUUID();
    const body = { url: 'https://example.com/shared-key' };

    const a = await create(first.apiKey, body, key);
    const b = await create(second.apiKey, body, key);

    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.body.code).not.toBe(a.body.code);
  });

  it('refuses keys that are empty, too long or not plain ASCII', async () => {
    const { id, apiKey } = await makeKey();
    for (const key of ['', 'x'.repeat(256), 'has space', 'tab\there']) {
      const res = await create(apiKey, { url: 'https://example.com/bad-key' }, key);
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(res.body.error).toBe('invalid_idempotency_key');
    }
    expect(await linkCount(id)).toBe(0);
  });

  it('accepts a key of exactly 255 characters', async () => {
    const { apiKey } = await makeKey();
    const res = await create(apiKey, { url: 'https://example.com/long-key' }, 'k'.repeat(255));
    expect(res.status).toBe(201);
  });

  it('does not record requests that fail validation', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();

    expect((await create(apiKey, { url: 'not a url' }, key)).status).toBe(400);
    expect(await rowFor(id, key)).toBeUndefined();

    const fixed = await create(apiKey, { url: 'https://example.com/fixed' }, key);
    expect(fixed.status).toBe(201);
    expect(fixed.headers['idempotent-replayed']).toBeUndefined();
  });

  it('records and replays a refusal such as a taken alias', async () => {
    const owner = await makeKey();
    const other = await makeKey();
    const alias = `idem-${Date.now().toString(36)}`;
    codes.add(alias);
    await create(owner.apiKey, { url: 'https://example.com/owner', alias });

    const key = randomUUID();
    const body = { url: 'https://example.com/other', alias };
    const first = await create(other.apiKey, body, key);
    const again = await create(other.apiKey, body, key);

    expect(first.status).toBe(409);
    expect(again.status).toBe(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
  });

  it('forgets a request that failed on the server, so it can be retried', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const body = { url: 'https://example.com/retry' };
    const original = pool.query.bind(pool);
    vi.spyOn(pool, 'query').mockImplementation((text, params) =>
      String(text).includes('nextval') ? Promise.reject(new Error('database blip')) : original(text, params)
    );

    expect((await create(apiKey, body, key)).status).toBe(500);
    vi.restoreAllMocks();
    expect(await rowFor(id, key)).toBeUndefined();

    const retry = await create(apiKey, body, key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await linkCount(id)).toBe(1);
  });

  it('answers 409 while the first request is still running', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const body = { url: 'https://example.com/running' };
    await plant(id, key, hashOf(body));

    const res = await create(apiKey, body, key);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('idempotency_request_in_progress');
    expect(res.headers['retry-after']).toBe('1');
    expect(await linkCount(id)).toBe(0);
  });

  it('lets exactly one of several simultaneous requests create the link', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const body = { url: 'https://example.com/simultaneous' };

    const results = await Promise.all(Array.from({ length: 8 }, () => create(apiKey, body, key)));
    const created = results.filter((res) => res.status === 201);
    const waiting = results.filter((res) => res.status === 409);

    expect(created.length + waiting.length).toBe(8);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((res) => res.body.code)).size).toBe(1);
    expect(created.filter((res) => res.headers['idempotent-replayed'] === undefined)).toHaveLength(1);
    for (const res of waiting) expect(res.body.error).toBe('idempotency_request_in_progress');
    expect(await linkCount(id)).toBe(1);
  });

  it('takes over a request that was abandoned mid-way', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    const body = { url: 'https://example.com/abandoned' };
    await plant(id, key, hashOf(body), "now() - interval '5 minutes'");

    const res = await create(apiKey, body, key);
    expect(res.status).toBe(201);
    expect((await rowFor(id, key)).status).toBe('done');
  });

  it('does not let a different request take over an abandoned key', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    await plant(id, key, hashOf({ url: 'https://example.com/a' }), "now() - interval '5 minutes'");

    const res = await create(apiKey, { url: 'https://example.com/b' }, key);
    expect(res.status).toBe(422);
  });

  it('forgets a key after 24 hours', async () => {
    const { id, apiKey } = await makeKey();
    const key = randomUUID();
    await create(apiKey, { url: 'https://example.com/old' }, key);
    await query(
      `UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE api_key_id = $1 AND key = $2`,
      [id, key]
    );

    const res = await create(apiKey, { url: 'https://example.com/new' }, key);
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(await linkCount(id)).toBe(2);
  });

  it('is not used for key creation, which never stores a readable key', async () => {
    const key = randomUUID();
    const first = await request(app).post('/api/v1/keys').set('Idempotency-Key', key).send({ name: 'a' });
    const second = await request(app).post('/api/v1/keys').set('Idempotency-Key', key).send({ name: 'a' });
    keyIds.push(first.body.id, second.body.id);

    expect(second.body.apiKey).not.toBe(first.body.apiKey);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('idempotency records', () => {
  it('only lets the current owner save or release a key', async () => {
    const { id } = await makeKey();
    const key = randomUUID();
    const stale = randomUUID();
    const fresh = randomUUID();

    expect(await claimIdempotencyKey({ apiKeyId: id, key, requestHash: 'h', token: stale })).toBe(true);
    await query(`UPDATE idempotency_keys SET locked_at = now() - interval '5 minutes' WHERE api_key_id = $1`, [id]);
    expect(await claimIdempotencyKey({ apiKeyId: id, key, requestHash: 'h', token: fresh })).toBe(true);

    expect(await saveIdempotentResponse({ apiKeyId: id, key, token: stale, status: 201, body: { a: 1 } })).toBe(false);
    expect(await releaseIdempotencyKey({ apiKeyId: id, key, token: stale })).toBe(false);
    expect(await saveIdempotentResponse({ apiKeyId: id, key, token: fresh, status: 201, body: { a: 2 } })).toBe(true);

    expect((await findIdempotencyKey(id, key)).responseBody).toEqual({ a: 2 });
  });

  it('does not take over a key that is still fresh', async () => {
    const { id } = await makeKey();
    const key = randomUUID();
    expect(await claimIdempotencyKey({ apiKeyId: id, key, requestHash: 'h', token: randomUUID() })).toBe(true);
    expect(await claimIdempotencyKey({ apiKeyId: id, key, requestHash: 'h', token: randomUUID() })).toBe(false);
  });

  it('never releases a finished key', async () => {
    const { id } = await makeKey();
    const key = randomUUID();
    const token = randomUUID();
    await claimIdempotencyKey({ apiKeyId: id, key, requestHash: 'h', token });
    await saveIdempotentResponse({ apiKeyId: id, key, token, status: 201, body: {} });

    expect(await releaseIdempotencyKey({ apiKeyId: id, key, token })).toBe(false);
    expect(await findIdempotencyKey(id, key)).toBeDefined();
  });

  it('removes only expired keys in the cleanup', async () => {
    const { id } = await makeKey();
    await plant(id, 'old', 'h');
    await plant(id, 'new', 'h');
    await query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE api_key_id = $1 AND key = 'old'`, [id]);

    expect(await deleteExpiredIdempotencyKeys()).toBeGreaterThanOrEqual(1);
    expect(await findIdempotencyKey(id, 'old')).toBeUndefined();
    expect(await findIdempotencyKey(id, 'new')).toBeDefined();
  });

  it('removes the keys of a deleted API key', async () => {
    const { id } = await makeKey();
    await plant(id, 'gone', 'h');
    await query('DELETE FROM api_keys WHERE id = $1', [id]);
    expect(await findIdempotencyKey(id, 'gone')).toBeUndefined();
  });
});
