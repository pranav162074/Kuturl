import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import pool, { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import codes from '../src/services/codes.js';
import { reserveLinkId, insertLink } from '../src/db/links.js';

const keyIds = []; // every key made here is removed in afterAll (its links cascade)

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  await closePool();
  await redis.quit();
});

const makeKey = async (name = 'shorten test') => {
  const res = await request(app).post('/api/v1/keys').send({ name });
  expect(res.status).toBe(201);
  keyIds.push(res.body.id);
  return { id: res.body.id, apiKey: res.body.apiKey };
};

const create = (apiKey, body) =>
  request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send(body);

const rowFor = async (code) => (await query('SELECT * FROM links WHERE code = $1', [code])).rows[0];

describe('POST /api/v1/keys', () => {
  it('creates a key, shows it once, and stores only its hash', async () => {
    const res = await request(app).post('/api/v1/keys').send({ name: '  my key  ' });
    keyIds.push(res.body.id);

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.apiKey).toMatch(/^kt_[A-Za-z0-9_-]{32}$/);
    expect(res.body.keyPrefix).toBe(res.body.apiKey.slice(0, 8));
    expect(res.body.name).toBe('my key'); // trimmed

    const { rows } = await query('SELECT * FROM api_keys WHERE id = $1', [res.body.id]);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(res.body.apiKey);
  });

  it('gives every key a different value', async () => {
    const a = await makeKey();
    const b = await makeKey();
    expect(a.apiKey).not.toBe(b.apiKey);
  });

  it('rejects a missing, empty or oversized name, and unknown fields', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 'ok', admin: true }]) {
      const res = await request(app).post('/api/v1/keys').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('validation_error');
    }
  });
});

describe('authentication on POST /api/v1/links', () => {
  it('rejects a missing key, a malformed key and an unknown key the same way', async () => {
    const body = { url: 'https://example.com' };
    const attempts = [
      request(app).post('/api/v1/links').send(body),
      request(app).post('/api/v1/links').set('Authorization', 'Bearer nonsense').send(body),
      request(app).post('/api/v1/links').set('Authorization', 'Basic abc').send(body),
      request(app).post('/api/v1/links').set('Authorization', `Bearer kt_${'a'.repeat(32)}`).send(body),
    ];

    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('answers 401 before it looks at the body', async () => {
    const res = await request(app).post('/api/v1/links').send({ url: 'javascript:alert(1)' });
    expect(res.status).toBe(401);
  });

  it('stops accepting a key once it is revoked', async () => {
    const { id, apiKey } = await makeKey('to revoke');
    expect((await create(apiKey, { url: 'https://example.com' })).status).toBe(201);

    await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [id]);
    expect((await create(apiKey, { url: 'https://example.com' })).status).toBe(401);
  });

  it('accepts the scheme in any letter case', async () => {
    const { apiKey } = await makeKey();
    const res = await request(app)
      .post('/api/v1/links')
      .set('Authorization', `bearer ${apiKey}`)
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(201);
  });
});

describe('creating links', () => {
  it('creates a link with a 7 character code and a normalised URL', async () => {
    const { id, apiKey } = await makeKey();
    const res = await create(apiKey, { url: '  HTTPS://EXAMPLE.com/Path?q=1 ' });

    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(res.body.shortUrl).toBe(`http://localhost:3000/${res.body.code}`);
    expect(res.body.longUrl).toBe('https://example.com/Path?q=1');
    expect(res.body.expiresAt).toBeNull();
    expect(Object.keys(res.body).sort()).toEqual(['code', 'createdAt', 'expiresAt', 'longUrl', 'shortUrl']);

    const row = await rowFor(res.body.code);
    expect(row.api_key_id).toBe(id);
    expect(row.is_custom).toBe(false);
  });

  it('derives the code from the row id', async () => {
    const { apiKey } = await makeKey();
    const res = await create(apiKey, { url: 'https://example.com' });
    const row = await rowFor(res.body.code);
    expect(codes.decode(res.body.code)).toBe(BigInt(row.id));
  });

  it('gives the same URL a new code every time', async () => {
    const { apiKey } = await makeKey();
    const first = await create(apiKey, { url: 'https://example.com/same' });
    const second = await create(apiKey, { url: 'https://example.com/same' });
    expect(first.body.code).not.toBe(second.body.code);
  });

  it('stores an expiry when one is given', async () => {
    const { apiKey } = await makeKey();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const res = await create(apiKey, { url: 'https://example.com', expiresAt: expiresAt.toISOString() });

    expect(res.status).toBe(201);
    expect(new Date(res.body.expiresAt).getTime()).toBe(expiresAt.getTime());
    expect((await rowFor(res.body.code)).expires_at.getTime()).toBe(expiresAt.getTime());
  });

  it('gives 20 simultaneous requests 20 different codes', async () => {
    const { apiKey } = await makeKey();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => create(apiKey, { url: `https://example.com/${i}` }))
    );

    expect(results.every((res) => res.status === 201)).toBe(true);
    expect(new Set(results.map((res) => res.body.code)).size).toBe(20);
  });

  it('moves on to the next id when a code is already taken', async () => {
    const { id, apiKey } = await makeKey();

    // Plant a link whose code is exactly what the next generated id would produce
    const reserved = BigInt(await reserveLinkId());
    const nextCode = codes.encode(reserved + 1n);
    await insertLink({ id: reserved, code: nextCode, longUrl: 'https://example.com/planted', apiKeyId: id });

    const res = await create(apiKey, { url: 'https://example.com/real' });

    expect(res.status).toBe(201);
    expect(res.body.code).not.toBe(nextCode);
    expect(res.body.code).toBe(codes.encode(reserved + 2n));
  });

  it('returns every connection to the pool', async () => {
    const { apiKey } = await makeKey();
    await Promise.all(Array.from({ length: 10 }, () => create(apiKey, { url: 'https://example.com' })));
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });
});

describe('rejected requests', () => {
  it('rejects bad URLs with a reason, and stores nothing', async () => {
    const { id, apiKey } = await makeKey();

    const cases = {
      'javascript:alert(1)': 'Only http and https URLs can be shortened',
      'http://127.0.0.1/admin': 'Links to private or internal addresses are not allowed',
      'https://user:pass@example.com': 'URLs with a username or password are not allowed',
      'not a url': 'URL must not contain spaces or control characters',
    };
    for (const [url, message] of Object.entries(cases)) {
      const res = await create(apiKey, { url });
      expect(res.status, url).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.message).toBe(message);
    }

    const { rows } = await query('SELECT count(*)::int AS n FROM links WHERE api_key_id = $1', [id]);
    expect(rows[0].n).toBe(0);
  });

  it('rejects a missing URL, a bad expiry and unknown fields', async () => {
    const { apiKey } = await makeKey();
    const past = new Date(Date.now() - 3600_000).toISOString();

    for (const body of [
      {},
      { url: 123 },
      { url: 'https://example.com', expiresAt: past },
      { url: 'https://example.com', expiresAt: 'tomorrow' },
      { url: 'https://example.com', expires_at: '2030-01-01T00:00:00Z' },
    ]) {
      const res = await create(apiKey, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('returns a 400 for malformed JSON and always includes a request id', async () => {
    const { apiKey } = await makeKey();
    const res = await request(app)
      .post('/api/v1/links')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Content-Type', 'application/json')
      .send('{"url":');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});