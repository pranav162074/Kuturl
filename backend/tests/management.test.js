import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { reserveLinkId, insertLink } from '../src/db/links.js';
import { revokeApiKey } from '../src/db/apiKeys.js';
import { getEntry, setEntry, fillEntry, resetBreaker } from '../src/services/linkCache.js';
import codes from '../src/services/codes.js';

const keyIds = [];
const touched = new Set();
const cacheKey = (code) => `link:${code}`;
const hour = 60 * 60 * 1000;

const api = (method, path, apiKey) => {
  const req = request(app)[method](path);
  return apiKey ? req.set('Authorization', `Bearer ${apiKey}`) : req;
};
const go = (code) => request(app).get(`/${code}`);

const makeKey = async (name = 'management test') => {
  const res = await request(app).post('/api/v1/keys').send({ name });
  keyIds.push(res.body.id);
  return { id: res.body.id, apiKey: res.body.apiKey };
};

const makeLink = async (apiKey, url = 'https://example.com/target', extra = {}) => {
  const res = await api('post', '/api/v1/links', apiKey).send({ url, ...extra });
  expect(res.status).toBe(201);
  touched.add(res.body.code);
  return res.body;
};

const rowFor = async (code) => (await query('SELECT * FROM links WHERE code = $1', [code])).rows[0];

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (touched.size > 0) await redis.del(...[...touched].map(cacheKey));
  await closePool();
  await redis.quit();
});

describe('key management', () => {
  it('shows the current key without ever exposing the key or its hash', async () => {
    const { id, apiKey } = await makeKey('my key');
    const res = await api('get', '/api/v1/keys/me', apiKey);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'keyPrefix', 'name']);
    expect(res.body.id).toBe(id);
    expect(res.body.keyPrefix).toBe(apiKey.slice(0, 8));
    expect(JSON.stringify(res.body)).not.toContain(apiKey);
  });

  it('needs a key for every management endpoint', async () => {
    const code = 'abcdefg';
    for (const [method, path] of [
      ['get', '/api/v1/keys/me'],
      ['delete', '/api/v1/keys/me'],
      ['get', '/api/v1/links'],
      ['get', `/api/v1/links/${code}`],
      ['patch', `/api/v1/links/${code}`],
      ['delete', `/api/v1/links/${code}`],
    ]) {
      const res = await api(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('revokes a key, which stops working at once', async () => {
    const { apiKey } = await makeKey();
    expect((await api('delete', '/api/v1/keys/me', apiKey)).status).toBe(204);

    expect((await api('get', '/api/v1/keys/me', apiKey)).status).toBe(401);
    expect((await api('post', '/api/v1/links', apiKey).send({ url: 'https://example.com' })).status).toBe(401);
  });

  it('keeps the original revocation time if a key is revoked again', async () => {
    const { id, apiKey } = await makeKey();
    await api('delete', '/api/v1/keys/me', apiKey);
    const first = (await query('SELECT revoked_at FROM api_keys WHERE id = $1', [id])).rows[0].revoked_at;

    expect(await revokeApiKey(id)).toBe(true);
    const second = (await query('SELECT revoked_at FROM api_keys WHERE id = $1', [id])).rows[0].revoked_at;
    expect(second.getTime()).toBe(first.getTime());
  });

  it('leaves the links of a revoked key working', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey);
    await api('delete', '/api/v1/keys/me', apiKey);

    expect((await go(link.code)).status).toBe(302);
  });
});

describe('viewing links', () => {
  it('shows a link with its status', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey, 'https://example.com/view');
    const res = await api('get', `/api/v1/links/${link.code}`, apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      code: link.code,
      shortUrl: link.shortUrl,
      longUrl: 'https://example.com/view',
      status: 'active',
      disabledAt: null,
      isCustom: false,
    });
  });

  it('reports disabled and expired links as such', async () => {
    const { id, apiKey } = await makeKey();
    const disabled = await makeLink(apiKey);
    await query('UPDATE links SET disabled_at = now() WHERE code = $1', [disabled.code]);

    const expiredId = await reserveLinkId();
    const expiredCode = codes.encode(expiredId);
    touched.add(expiredCode);
    await insertLink({
      id: expiredId,
      code: expiredCode,
      longUrl: 'https://example.com/old',
      apiKeyId: id,
      expiresAt: new Date(Date.now() - hour),
    });

    expect((await api('get', `/api/v1/links/${disabled.code}`, apiKey)).body.status).toBe('disabled');
    expect((await api('get', `/api/v1/links/${expiredCode}`, apiKey)).body.status).toBe('expired');
  });

  it('answers 404 for someone else\'s link, exactly as for one that does not exist', async () => {
    const owner = await makeKey('owner');
    const other = await makeKey('other');
    const link = await makeLink(owner.apiKey);

    const foreign = await api('get', `/api/v1/links/${link.code}`, other.apiKey);
    const missing = await api('get', `/api/v1/links/${codes.encode(await reserveLinkId())}`, other.apiKey);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect((await api('get', '/api/v1/links/has%20space', owner.apiKey)).status).toBe(404);
  });
});

describe('listing links', () => {
  it('lists only your own links, newest first', async () => {
    const mine = await makeKey('mine');
    const theirs = await makeKey('theirs');
    const first = await makeLink(mine.apiKey, 'https://example.com/1');
    const second = await makeLink(mine.apiKey, 'https://example.com/2');
    await makeLink(theirs.apiKey, 'https://example.com/other');

    const res = await api('get', '/api/v1/links', mine.apiKey);
    expect(res.status).toBe(200);
    expect(res.body.links.map((l) => l.code)).toEqual([second.code, first.code]);
    expect(res.body.nextCursor).toBeNull();

    expect((await api('get', '/api/v1/links', (await makeKey()).apiKey)).body.links).toEqual([]);
  });

  it('pages through every link exactly once with the cursor', async () => {
    const { apiKey } = await makeKey();
    const created = [];
    for (let i = 0; i < 5; i += 1) created.push((await makeLink(apiKey, `https://example.com/${i}`)).code);

    const seen = [];
    const pageSizes = [];
    let cursor;
    do {
      const res = await api('get', `/api/v1/links?limit=2${cursor ? `&cursor=${cursor}` : ''}`, apiKey);
      expect(res.status).toBe(200);
      pageSizes.push(res.body.links.length);
      seen.push(...res.body.links.map((l) => l.code));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(pageSizes).toEqual([2, 2, 1]);
    expect(seen).toEqual([...created].reverse());
  });

  it('returns no cursor when the last page is exactly full', async () => {
    const { apiKey } = await makeKey();
    for (let i = 0; i < 3; i += 1) await makeLink(apiKey, `https://example.com/${i}`);

    const res = await api('get', '/api/v1/links?limit=3', apiKey);
    expect(res.body.links).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it('hands out cursors that look like codes, never raw ids', async () => {
    const { apiKey } = await makeKey();
    await makeLink(apiKey);
    const second = await makeLink(apiKey);
    await makeLink(apiKey);

    const res = await api('get', '/api/v1/links?limit=2', apiKey);
    expect(res.body.nextCursor).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(res.body.nextCursor).toBe(second.code);
  });

  it('rejects bad limits and bad cursors', async () => {
    const { apiKey } = await makeKey();
    for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'cursor=abc', 'cursor=ZZZZZZZ', 'cursor=ab-defg']) {
      const res = await api('get', `/api/v1/links?${qs}`, apiKey);
      expect(res.status, qs).toBe(400);
      expect(res.body.error).toBe('validation_error');
    }
  });
});

describe('changing a link', () => {
  it('disables a link, and redirects stop immediately even when it was cached', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey);

    await go(link.code); // fills the cache
    expect((await go(link.code)).headers['x-cache']).toBe('HIT');

    const res = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ disabled: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');

    const after = await go(link.code);
    expect(after.status).toBe(410);
    expect(after.body.error).toBe('link_disabled');
    expect(after.headers['x-cache']).toBe('HIT'); // served from the cache, which holds the new state

    const entry = JSON.parse(await redis.get(cacheKey(link.code)));
    expect(entry.s).toBe('disabled');
    expect(await redis.ttl(cacheKey(link.code))).toBeLessThanOrEqual(60);
  });

  it('re-enables a link', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey, 'https://example.com/back');

    await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ disabled: true });
    expect((await go(link.code)).status).toBe(410);

    const res = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ disabled: false });
    expect(res.body.status).toBe('active');
    expect(res.body.disabledAt).toBeNull();

    const after = await go(link.code);
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('https://example.com/back');
  });

  it('keeps the first disabled time when a link is disabled twice', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey);

    const first = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ disabled: true });
    const second = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ disabled: true });
    expect(second.body.disabledAt).toBe(first.body.disabledAt);
  });

  it('changes and removes an expiry, and the cache follows', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey);
    await go(link.code);

    const expiresAt = new Date(Date.now() + 2 * hour).toISOString();
    const set = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ expiresAt });
    expect(set.status).toBe(200);
    expect(new Date(set.body.expiresAt).toISOString()).toBe(expiresAt);

    const removed = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ expiresAt: null });
    expect(removed.body.expiresAt).toBeNull();
    expect(await redis.ttl(cacheKey(link.code))).toBeGreaterThan(3000); // no expiry, so a full-length entry
    expect((await go(link.code)).status).toBe(302);
  });

  it('refuses to change the destination, and anything it does not know', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey, 'https://example.com/original');

    for (const body of [
      { url: 'https://evil.example/phish' },
      { longUrl: 'https://evil.example/phish' },
      { disabled: 'yes' },
      { expiresAt: 'tomorrow' },
      { expiresAt: new Date(Date.now() - hour).toISOString() },
      {},
    ]) {
      const res = await api('patch', `/api/v1/links/${link.code}`, apiKey).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await rowFor(link.code)).long_url).toBe('https://example.com/original');
  });

  it('cannot change someone else\'s link', async () => {
    const owner = await makeKey('owner');
    const other = await makeKey('other');
    const link = await makeLink(owner.apiKey);

    const res = await api('patch', `/api/v1/links/${link.code}`, other.apiKey).send({ disabled: true });
    expect(res.status).toBe(404);
    expect((await rowFor(link.code)).disabled_at).toBeNull();
    expect((await go(link.code)).status).toBe(302);
  });

  it('still saves the change when Redis cannot be updated', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey);
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('redis is down'));

    const res = await api('patch', `/api/v1/links/${link.code}`, apiKey).send({ disabled: true });
    expect(res.status).toBe(200);
    expect((await rowFor(link.code)).disabled_at).not.toBeNull();
  });
});

describe('deleting a link', () => {
  it('deletes it, and the cache stops the redirect at once', async () => {
    const { apiKey } = await makeKey();
    const link = await makeLink(apiKey);
    await go(link.code);

    expect((await api('delete', `/api/v1/links/${link.code}`, apiKey)).status).toBe(204);
    expect(await rowFor(link.code)).toBeUndefined();

    const after = await go(link.code);
    expect(after.status).toBe(404);
    expect(after.headers['x-cache']).toBe('HIT');
    expect(JSON.parse(await redis.get(cacheKey(link.code))).s).toBe('missing');
    expect(await redis.ttl(cacheKey(link.code))).toBeLessThanOrEqual(30);
  });

  it('answers 404 the second time, and for someone else\'s link', async () => {
    const owner = await makeKey('owner');
    const other = await makeKey('other');
    const link = await makeLink(owner.apiKey);

    expect((await api('delete', `/api/v1/links/${link.code}`, other.apiKey)).status).toBe(404);
    expect(await rowFor(link.code)).toBeDefined();

    expect((await api('delete', `/api/v1/links/${link.code}`, owner.apiKey)).status).toBe(204);
    expect((await api('delete', `/api/v1/links/${link.code}`, owner.apiKey)).status).toBe(404);
  });
});

describe('cache rules for writes', () => {
  it('never lets a slow reader overwrite a newer entry', async () => {
    const code = codes.encode(await reserveLinkId());
    touched.add(code);

    // The owner has just disabled the link, and a reader that loaded the old row now fills the cache
    await setEntry(code, { s: 'disabled' });
    await fillEntry(code, { s: 'active', u: 'https://example.com/stale', e: null });

    expect(await getEntry(code)).toEqual({ s: 'disabled' });
  });

  it('lets a fill write when nothing is cached yet', async () => {
    const code = codes.encode(await reserveLinkId());
    touched.add(code);

    await fillEntry(code, { s: 'missing' });
    expect(await getEntry(code)).toEqual({ s: 'missing' });
  });

  it('writes a change even while the circuit breaker is skipping reads', async () => {
    const code = codes.encode(await reserveLinkId());
    touched.add(code);

    const get = vi.spyOn(redis, 'get').mockRejectedValue(new Error('blip'));
    await getEntry(code); // fails, which trips the breaker
    get.mockRestore();

    await setEntry(code, { s: 'disabled' });
    expect(JSON.parse(await redis.get(cacheKey(code))).s).toBe('disabled');
  });

  it('removes an entry it did not write, so the fill that follows can replace it', async () => {
    const code = codes.encode(await reserveLinkId());
    touched.add(code);

    await redis.set(cacheKey(code), 'not an entry');
    expect(await getEntry(code)).toBeNull();
    expect(await redis.exists(cacheKey(code))).toBe(0);
  });
});