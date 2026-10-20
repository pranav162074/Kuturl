import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import codes from '../src/services/codes.js';
import { reserveLinkId, insertLink } from '../src/db/links.js';
import { resetBreaker, ttlFor, entryFromLink, TTL_SECONDS } from '../src/services/linkCache.js';

let keyId;
let apiKey;
const touched = new Set(); // every code used here, so its cache entry can be removed afterwards

const track = (code) => {
  touched.add(code);
  return code;
};
const cacheKey = (code) => `link:${code}`;
const go = (code, headers = {}) => request(app).get(`/${code}`).set(headers);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Inserts a link directly, which also allows states the API refuses (such as an expiry in the past)
const plant = async ({ expiresAt = null, url = 'https://example.com/target' } = {}) => {
  const id = await reserveLinkId();
  const code = track(codes.encode(id));
  await insertLink({ id, code, longUrl: url, apiKeyId: keyId, expiresAt });
  return code;
};

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'redirect test' });
  keyId = res.body.id;
  apiKey = res.body.apiKey;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = $1', [keyId]); // its links go with it
  if (touched.size > 0) await redis.del(...[...touched].map(cacheKey));
  await closePool();
  await redis.quit();
});

describe('cache entry rules', () => {
  const now = 1_000_000_000_000;

  it('describes a link as missing, disabled or active', () => {
    expect(entryFromLink(undefined)).toEqual({ s: 'missing' });
    expect(entryFromLink({ disabledAt: new Date() })).toEqual({ s: 'disabled' });
    expect(entryFromLink({ longUrl: 'https://a.example', expiresAt: null })).toEqual({
      s: 'active',
      u: 'https://a.example',
      e: null,
    });
    expect(entryFromLink({ longUrl: 'https://a.example', expiresAt: new Date(now) }).e).toBe(now);
  });

  it('treats a disabled link as disabled even if it has also expired', () => {
    expect(entryFromLink({ disabledAt: new Date(), expiresAt: new Date(now - 1000) })).toEqual({ s: 'disabled' });
  });

  it('chooses a lifetime for each kind of entry', () => {
    expect(ttlFor({ s: 'missing' }, now)).toBe(TTL_SECONDS.missing);
    expect(ttlFor({ s: 'disabled' }, now)).toBe(TTL_SECONDS.unavailable);
    expect(ttlFor({ s: 'active', u: 'x', e: null }, now)).toBe(TTL_SECONDS.active);
  });

  it('never keeps a link cached past its own expiry', () => {
    expect(ttlFor({ s: 'active', u: 'x', e: now + 90_000 }, now)).toBe(90);
    expect(ttlFor({ s: 'active', u: 'x', e: now + 90_500 }, now)).toBe(91); // rounds up
    expect(ttlFor({ s: 'active', u: 'x', e: now + 10 * 3_600_000 }, now)).toBe(TTL_SECONDS.active);
  });

  it('keeps only a short record of a link that has already expired', () => {
    expect(ttlFor({ s: 'active', u: 'x', e: now - 1 }, now)).toBe(TTL_SECONDS.unavailable);
  });
});

describe('redirecting', () => {
  it('sends a 302 to the long URL, and never lets the response be cached', async () => {
    const code = await plant({ url: 'https://example.com/some/page?x=1' });
    const res = await go(code);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/some/page?x=1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('works end to end for a link made through the API', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: 'https://example.com/round/trip?x=1' });
    track(created.body.code);

    const res = await go(created.body.code);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/round/trip?x=1');
  });

  it('reads from Postgres the first time and from Redis after that', async () => {
    const code = await plant();

    const first = await go(code);
    expect(first.status).toBe(302);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await go(code);
    expect(second.status).toBe(302);
    expect(second.headers['x-cache']).toBe('HIT');
  });

  it('keeps serving from Redis without touching Postgres at all', async () => {
    const code = await plant({ url: 'https://example.com/cached' });
    await go(code); // fills the cache

    await query('DELETE FROM links WHERE code = $1', [code]);

    const res = await go(code);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/cached');
    expect(res.headers['x-cache']).toBe('HIT');
  });

  it('keeps a cached link no longer than the link itself lives', async () => {
    const code = await plant({ expiresAt: new Date(Date.now() + 120_000) });
    await go(code);

    const ttl = await redis.ttl(cacheKey(code));
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('serves 30 simultaneous first requests', async () => {
    const code = await plant();
    const results = await Promise.all(Array.from({ length: 30 }, () => go(code)));
    expect(results.every((res) => res.status === 302)).toBe(true);
  });

  it('treats codes as case sensitive', async () => {
    const id = await reserveLinkId();
    const code = track(`Case${Date.now().toString(36)}`);
    await insertLink({ id, code, longUrl: 'https://example.com', apiKeyId: keyId });

    expect((await go(code)).status).toBe(302);
    expect((await go(code.toLowerCase())).status).toBe(404);
  });
});

describe('links that cannot be followed', () => {
  it('answers 404 with JSON for a code that does not exist', async () => {
    const code = track(codes.encode(await reserveLinkId()));
    const res = await go(code);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 410 for an expired link', async () => {
    const code = await plant({ expiresAt: new Date(Date.now() - 60_000) });
    const res = await go(code);

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('link_expired');
    expect(res.headers['cache-control']).toBe('no-store');

    const ttl = await redis.ttl(cacheKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TTL_SECONDS.unavailable);
  });

  it('answers 410 for a disabled link', async () => {
    const code = await plant();
    await query('UPDATE links SET disabled_at = now() WHERE code = $1', [code]);

    const res = await go(code);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('link_disabled');
  });

  it('notices an expiry that happens while the link is cached', async () => {
    const code = await plant({ expiresAt: new Date(Date.now() + 1500) });

    expect((await go(code)).status).toBe(302);
    expect((await go(code)).headers['x-cache']).toBe('HIT');

    await sleep(1700);

    // Whether this is served from Redis or Postgres, the clock decides
    const res = await go(code);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('link_expired');
  });

  it('remembers that a code does not exist, until the entry is cleared', async () => {
    const id = await reserveLinkId();
    const code = track(codes.encode(id));

    const first = await go(code);
    expect(first.status).toBe(404);
    expect(first.headers['x-cache']).toBe('MISS');

    // The link appears in Postgres, but the cached "missing" answer still wins
    await insertLink({ id, code, longUrl: 'https://example.com/late', apiKeyId: keyId });
    const second = await go(code);
    expect(second.status).toBe(404);
    expect(second.headers['x-cache']).toBe('HIT');

    await redis.del(cacheKey(code));
    expect((await go(code)).status).toBe(302);
  });

  it('shows a page to browsers and JSON to everyone else', async () => {
    const code = track(codes.encode(await reserveLinkId()));

    const browser = await go(code, { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    expect(browser.status).toBe(404);
    expect(browser.headers['content-type']).toMatch(/html/);
    expect(browser.text).toContain('Link not found');

    const api = await go(code, { Accept: 'application/json' });
    expect(api.headers['content-type']).toMatch(/json/);
  });
});

describe('codes that cannot be valid', () => {
  it('answers 404 without touching the cache', async () => {
    for (const code of ['x'.repeat(33), 'has%20space', 'dots.in.code', 'favicon.ico']) {
      const res = await go(code);
      expect(res.status, code).toBe(404);
      expect(await redis.exists(cacheKey(decodeURIComponent(code)))).toBe(0);
    }
  });

  it('never puts the requested path into the page', async () => {
    const res = await go('%3Cscript%3Ealert(1)%3C%2Fscript%3E', { Accept: 'text/html' });
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('alert');
  });

  it('leaves the other routes alone', async () => {
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
    const missing = await request(app).get('/api/v1/nothing/here');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });
});

describe('when the cache misbehaves', () => {
  it('ignores entries it did not write, and replaces them', async () => {
    const code = await plant();

    await redis.set(cacheKey(code), 'definitely not json');
    const garbled = await go(code);
    expect(garbled.status).toBe(302);
    expect(garbled.headers['x-cache']).toBe('MISS');
    expect(JSON.parse(await redis.get(cacheKey(code))).s).toBe('active');

    await redis.set(cacheKey(code), JSON.stringify({ s: 'active' })); // active, but no URL
    expect((await go(code)).headers['x-cache']).toBe('MISS');
  });

  it('still redirects when Redis is down, and stops asking it for a while', async () => {
    const get = vi.spyOn(redis, 'get').mockRejectedValue(new Error('redis is down'));
    const code = await plant();

    const first = await go(code);
    const second = await go(code);

    expect(first.status).toBe(302);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.status).toBe(302);
    expect(second.headers['x-cache']).toBe('MISS');
    expect(get).toHaveBeenCalledTimes(1); // the second request skipped Redis entirely
  });

  it('gives up on a slow Redis instead of waiting for it', async () => {
    vi.spyOn(redis, 'get').mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 1000)));
    const code = await plant();

    const started = Date.now();
    const res = await go(code);

    expect(res.status).toBe(302);
    expect(Date.now() - started).toBeLessThan(600);
  });
});