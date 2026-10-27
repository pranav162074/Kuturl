import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import rateLimits from '../src/config/rateLimits.js';
import analytics from '../src/config/analytics.js';
import { resetBreaker } from '../src/services/linkCache.js';
import { resetRateLimiterBreaker } from '../src/services/rateLimiter.js';
import { hashPassword, verifyPassword, PASSWORD_PARAMS } from '../src/utils/password.js';
import { hashRequest, canonicalJson } from '../src/utils/requestHash.js';

const originalPolicies = structuredClone(rateLimits.policies);
const originalStream = analytics.streamKey;
const keyIds = [];
const touched = new Set();
const PASSWORD = 'open sesame';

let apiKey;
const runOctet = Math.floor(Math.random() * 250) + 1;
let ipCounter = 0;
const freshIp = () => {
  ipCounter += 1;
  return `172.20.${runOctet}.${ipCounter}`;
};

const create = async (body) => {
  const res = await request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send(body);
  if (res.body.code) touched.add(res.body.code);
  return res;
};

const protectedLink = async (extra = {}) => (await create({ url: 'https://example.com/secret', password: PASSWORD, ...extra })).body.code;

const unlock = (code, password, { json = false, ip = freshIp() } = {}) => {
  const req = request(app).post(`/${code}/unlock`).set('X-Forwarded-For', ip);
  if (json) return req.set('Accept', 'application/json').send({ password });
  return req.set('Accept', 'text/html').type('form').send(password === undefined ? '' : { password });
};

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'password test' });
  apiKey = res.body.apiKey;
  keyIds.push(res.body.id);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBreaker();
  resetRateLimiterBreaker();
  rateLimits.enabled = false;
  rateLimits.policies = structuredClone(originalPolicies);
  analytics.streamKey = originalStream;
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (touched.size > 0) await redis.del(...[...touched].map((code) => `link:${code}`));
  const limits = await redis.keys(`rl:unlock*:*172.20.${runOctet}.*`);
  const perLink = [...touched].map((code) => `rl:unlockLink:${code}`);
  const streams = await redis.keys('test:pw:*');
  const toDelete = [...limits, ...perLink, ...streams];
  if (toDelete.length > 0) await redis.del(...toDelete);
  await closePool();
  await redis.quit();
});

describe('password hashing', () => {
  it('stores scrypt with its settings, a random salt and no trace of the password', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).toMatch(new RegExp(`^scrypt\\$${PASSWORD_PARAMS.N}\\$8\\$1\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}$`));
    expect(first).not.toBe(second);
    expect(first).not.toContain('sesame');
  });

  it('accepts the right password and refuses anything else', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('open sesam', stored)).toBe(false);
    expect(await verifyPassword('Open sesame', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('treats different Unicode spellings of the same password alike', async () => {
    const stored = await hashPassword('café-123');
    expect(await verifyPassword('café-123', stored)).toBe(true);
  });

  it('rejects stored values it did not write, and unreasonable cost settings', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'plain')).toBe(false);
    const parts = stored.split('$');
    const key = parts.at(-1);
    parts[parts.length - 1] = `${key[0] === 'A' ? 'B' : 'A'}${key.slice(1)}`;
    expect(await verifyPassword(PASSWORD, parts.join('$'))).toBe(false);
    expect(await verifyPassword(PASSWORD, stored.replace(`$${PASSWORD_PARAMS.N}$`, '$99999999$'))).toBe(false);
  });

  it('keeps working for hashes made with older, cheaper settings', async () => {
    const old = await hashPassword(PASSWORD, { ...PASSWORD_PARAMS, N: 16384 });
    expect(old.startsWith('scrypt$16384$')).toBe(true);
    expect(await verifyPassword(PASSWORD, old)).toBe(true);
  });
});

describe('creating protected links', () => {
  it('stores only the hash and never returns it', async () => {
    const res = await create({ url: 'https://example.com/secret', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/sesame|scrypt|password/i);

    const { rows } = await query('SELECT password_hash FROM links WHERE code = $1', [res.body.code]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);

    const details = await request(app).get(`/api/v1/links/${res.body.code}`).set('Authorization', `Bearer ${apiKey}`);
    expect(details.body.passwordProtected).toBe(true);
    expect(JSON.stringify(details.body)).not.toMatch(/scrypt|sesame/);
  });

  it('marks ordinary links as not protected', async () => {
    const { code } = (await create({ url: 'https://example.com/open' })).body;
    const details = await request(app).get(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`);
    expect(details.body.passwordProtected).toBe(false);
  });

  it('checks the password length', async () => {
    for (const [password, message] of [
      ['12345', 'password must be at least 6 characters'],
      ['x'.repeat(129), 'password must be at most 128 characters'],
      [123456, 'password must be text'],
    ]) {
      const res = await create({ url: 'https://example.com/x', password });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    }
  });

  it('works with aliases and in bulk', async () => {
    const alias = `pw-${Date.now().toString(36)}`;
    touched.add(alias);
    expect((await create({ url: 'https://example.com/aliased', alias, password: PASSWORD })).status).toBe(201);
    expect((await request(app).get(`/${alias}`)).status).toBe(403);

    const res = await request(app)
      .post('/api/v1/links/bulk')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ links: [{ url: 'https://example.com/b1', password: PASSWORD }, { url: 'https://example.com/b2' }] });
    for (const r of res.body.results) touched.add(r.code);
    expect(res.status).toBe(201);
    expect((await request(app).get(`/${res.body.results[0].code}`)).status).toBe(403);
    expect((await request(app).get(`/${res.body.results[1].code}`)).status).toBe(302);
  });

  it('never stores a fast hash of the password in the idempotency record', async () => {
    const plain = hashRequest('POST', '/x', { url: 'u', password: PASSWORD });
    const same = hashRequest('POST', '/x', { password: PASSWORD, url: 'u' });
    const other = hashRequest('POST', '/x', { url: 'u', password: 'something else' });
    expect(plain).toBe(same);
    expect(plain).not.toBe(other);
    expect(canonicalJson({ links: [{ password: PASSWORD }] })).not.toContain(PASSWORD);
    expect(canonicalJson({ password: PASSWORD })).toMatch(/^\{"password":"hmac:[0-9a-f]{64}"\}$/);

    const key = randomUUID();
    const send = () =>
      request(app)
        .post('/api/v1/links')
        .set('Authorization', `Bearer ${apiKey}`)
        .set('Idempotency-Key', key)
        .send({ url: 'https://example.com/idem-secret', password: PASSWORD });
    const first = await send();
    touched.add(first.body.code);
    expect((await send()).headers['idempotent-replayed']).toBe('true');
  });
});

describe('following a protected link', () => {
  it('shows a password form to browsers, without revealing the destination', async () => {
    const code = await protectedLink();
    const res = await request(app).get(`/${code}`).set('Accept', 'text/html');

    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`action="/${code}/unlock"`);
    expect(res.text).toContain('type="password"');
    expect(res.text).not.toContain('example.com');
  });

  it('tells API clients where to send the password', async () => {
    const code = await protectedLink();
    const res = await request(app).get(`/${code}`).set('Accept', 'application/json');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'password_required', message: 'This link is protected by a password', unlockUrl: `/${code}/unlock` });
  });

  it('keeps the hash out of the cache, which only knows the link is protected', async () => {
    const code = await protectedLink();
    await request(app).get(`/${code}`);
    const entry = JSON.parse(await redis.get(`link:${code}`));
    expect(entry).toMatchObject({ s: 'active', p: true });
    expect(JSON.stringify(entry)).not.toMatch(/scrypt/);
    expect((await request(app).get(`/${code}`)).headers['x-cache']).toBe('HIT');
  });

  it('redirects after the right password, from a form or JSON', async () => {
    const code = await protectedLink();
    for (const json of [false, true]) {
      const res = await unlock(code, PASSWORD, { json });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://example.com/secret');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('refuses a wrong password and shows the form again', async () => {
    const code = await protectedLink();
    const page = await unlock(code, 'wrong password');
    expect(page.status).toBe(403);
    expect(page.headers.location).toBeUndefined();
    expect(page.text).toContain('That password is not right');

    const json = await unlock(code, 'wrong password', { json: true });
    expect(json.status).toBe(403);
    expect(json.body.error).toBe('wrong_password');
  });

  it('asks again when no password was sent', async () => {
    const code = await protectedLink();
    expect((await unlock(code, undefined)).status).toBe(400);
    expect((await unlock(code, '', { json: true })).body.error).toBe('password_required');
    expect((await unlock(code, 'x'.repeat(129), { json: true })).status).toBe(400);
  });

  it('records a click only once the link is opened', async () => {
    analytics.streamKey = `test:pw:${randomUUID()}`;
    const code = await protectedLink();
    await request(app).get(`/${code}`);
    await unlock(code, 'nope nope');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await redis.xlen(analytics.streamKey)).toBe(0);

    await unlock(code, PASSWORD);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await redis.xlen(analytics.streamKey)).toBe(1);
  });

  it('still honours disabling, expiry and deletion, even with the right password', async () => {
    const disabled = await protectedLink();
    await request(app).patch(`/api/v1/links/${disabled}`).set('Authorization', `Bearer ${apiKey}`).send({ disabled: true });
    expect((await unlock(disabled, PASSWORD, { json: true })).status).toBe(410);

    const deleted = await protectedLink();
    await request(app).delete(`/api/v1/links/${deleted}`).set('Authorization', `Bearer ${apiKey}`);
    expect((await unlock(deleted, PASSWORD, { json: true })).status).toBe(404);
    expect((await unlock('nosuchc', PASSWORD, { json: true })).status).toBe(404);
  });

  it('simply redirects when an unprotected link is unlocked', async () => {
    const { code } = (await create({ url: 'https://example.com/open-door' })).body;
    const res = await unlock(code, 'anything at all', { json: true });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/open-door');
  });
});

describe('changing the password', () => {
  it('protects an existing link at once, and can remove the password again', async () => {
    const { code } = (await create({ url: 'https://example.com/later' })).body;
    expect((await request(app).get(`/${code}`)).status).toBe(302);

    const set = await request(app).patch(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`).send({ password: 'new secret' });
    expect(set.body.passwordProtected).toBe(true);
    expect((await request(app).get(`/${code}`)).status).toBe(403);
    expect((await unlock(code, 'new secret')).status).toBe(302);

    const cleared = await request(app).patch(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`).send({ password: null });
    expect(cleared.body.passwordProtected).toBe(false);
    expect((await request(app).get(`/${code}`)).status).toBe(302);
  });

  it('replaces the old password', async () => {
    const code = await protectedLink();
    await request(app).patch(`/api/v1/links/${code}`).set('Authorization', `Bearer ${apiKey}`).send({ password: 'second one' });
    expect((await unlock(code, PASSWORD)).status).toBe(403);
    expect((await unlock(code, 'second one')).status).toBe(302);
  });
});

describe('guessing limits', () => {
  it('allows five tries per visitor per link, then 429 even with the right password', async () => {
    rateLimits.enabled = true;
    const code = await protectedLink();
    const ip = freshIp();

    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await unlock(code, `guess-${i}`, { ip })).status);
    const blocked = await unlock(code, PASSWORD, { ip, json: true });

    expect(statuses).toEqual([403, 403, 403, 403, 403]);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_attempts');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    expect((await unlock(code, PASSWORD, { ip: freshIp() })).status).toBe(302);
  });

  it('also limits each link across all visitors, against guessing from many addresses', async () => {
    rateLimits.enabled = true;
    rateLimits.policies.unlockLink = { capacity: 3, refillPerSecond: 0.001, failOpen: false };
    const code = await protectedLink();

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await unlock(code, `guess-${i}`)).status);
    expect(statuses).toEqual([403, 403, 403, 429]);
  });

  it('refuses to check passwords while the limiter is unavailable', async () => {
    rateLimits.enabled = true;
    const code = await protectedLink();
    vi.spyOn(redis, 'tokenBucket').mockRejectedValue(new Error('redis is down'));

    const res = await unlock(code, PASSWORD, { json: true });
    expect(res.status).toBe(503);
    expect(res.headers.location).toBeUndefined();
  });

  it('counts attempts by result', async () => {
    const code = await protectedLink();
    const read = async (result) => {
      const text = (await request(app).get('/metrics')).text;
      const line = text.split('\n').find((l) => l.startsWith(`kuturl_unlock_attempts_total{result="${result}"}`));
      return line ? Number(line.split(' ').at(-1)) : 0;
    };
    const wrong = await read('wrong_password');
    const success = await read('success');
    await unlock(code, 'bad guess');
    await unlock(code, PASSWORD);
    expect((await read('wrong_password')) - wrong).toBe(1);
    expect((await read('success')) - success).toBe(1);
  });
});
