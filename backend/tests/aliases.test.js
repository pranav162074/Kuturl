import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import codes from '../src/services/codes.js';
import { reserveLinkId, insertLink } from '../src/db/links.js';
import { CodeTakenError } from '../src/db/errors.js';
import { resetBreaker } from '../src/services/linkCache.js';

const stamp = Date.now().toString(36);
const keyIds = [];
const touched = new Set(); // every code used here, so its cache entry can be removed afterwards
const hour = 60 * 60 * 1000;

const track = (code) => {
  touched.add(code);
  return code;
};
const cacheKey = (code) => `link:${code}`;

const makeKey = async (name = 'alias test') => {
  const res = await request(app).post('/api/v1/keys').send({ name });
  keyIds.push(res.body.id);
  return { id: res.body.id, apiKey: res.body.apiKey };
};

const create = (apiKey, body) =>
  request(app).post('/api/v1/links').set('Authorization', `Bearer ${apiKey}`).send(body);

const createAlias = (apiKey, alias, extra = {}) =>
  create(apiKey, { url: 'https://example.com/aliased', alias: track(alias), ...extra });

const manage = (method, path, apiKey) =>
  request(app)[method](path).set('Authorization', `Bearer ${apiKey}`);

const go = (code) => request(app).get(`/${code}`);
const rowFor = async (code) => (await query('SELECT * FROM links WHERE code = $1', [code])).rows[0];

const plantCustom = async (apiKeyId, code) =>
  insertLink({ id: await reserveLinkId(), code, longUrl: 'https://example.com/planted', apiKeyId, isCustom: true });

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

describe('creating a link with an alias', () => {
  it('uses the alias as the code', async () => {
    const { apiKey } = await makeKey();
    const alias = `promo-${stamp}`;
    const res = await createAlias(apiKey, alias);

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(alias);
    expect(res.body.shortUrl).toBe(`http://localhost:3000/${alias}`);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'createdAt', 'expiresAt', 'longUrl', 'shortUrl']);
    expect((await rowFor(alias)).is_custom).toBe(true);
  });

  it('shows the link as custom in the management endpoints', async () => {
    const { apiKey } = await makeKey();
    const alias = `shown-${stamp}`;
    await createAlias(apiKey, alias);

    const one = await manage('get', `/api/v1/links/${alias}`, apiKey);
    expect(one.body.isCustom).toBe(true);

    const list = await manage('get', '/api/v1/links', apiKey);
    expect(list.body.links[0]).toMatchObject({ code: alias, isCustom: true });
  });

  it('works together with an expiry', async () => {
    const { apiKey } = await makeKey();
    const alias = `timed-${stamp}`;
    const expiresAt = new Date(Date.now() + hour);
    const res = await createAlias(apiKey, alias, { expiresAt: expiresAt.toISOString() });

    expect(res.status).toBe(201);
    expect((await rowFor(alias)).expires_at.getTime()).toBe(expiresAt.getTime());
  });

  it('redirects at the alias, and treats letter case as part of the address', async () => {
    const { apiKey } = await makeKey();
    const alias = `Mixed-${stamp}`;
    await createAlias(apiKey, alias);
    track(alias.toLowerCase());

    const exact = await go(alias);
    expect(exact.status).toBe(302);
    expect(exact.headers.location).toBe('https://example.com/aliased');
    expect((await go(alias.toLowerCase())).status).toBe(404);
  });

  it('accepts words that merely contain a reserved word', async () => {
    const { apiKey } = await makeKey();
    expect((await createAlias(apiKey, `api-docs-${stamp}`)).status).toBe(201);
  });
});

describe('rejected aliases', () => {
  it('rejects aliases that break the rules, and says which rule', async () => {
    const { id, apiKey } = await makeKey();
    const characters = 'alias may only contain letters, numbers, hyphens and underscores';
    const edges = 'alias must start and end with a letter or number';

    const cases = [
      ['ab', 'alias must be at least 3 characters'],
      ['x'.repeat(33), 'alias must be at most 32 characters'],
      ['has space', characters],
      ['dots.in.it', characters],
      ['ünïcode', characters],
      [' padded ', characters],
      ['-leading', edges],
      ['trailing-', edges],
      ['under_', edges],
    ];

    for (const [alias, message] of cases) {
      const res = await create(apiKey, { url: 'https://example.com', alias });
      expect(res.status, JSON.stringify(alias)).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.message, JSON.stringify(alias)).toBe(message);
    }

    const { rows } = await query('SELECT count(*)::int AS n FROM links WHERE api_key_id = $1', [id]);
    expect(rows[0].n).toBe(0);
  });

  it('rejects reserved words in any letter case', async () => {
    const { apiKey } = await makeKey();
    for (const alias of ['api', 'health', 'ping', 'metrics', 'docs', 'API', 'Docs', 'Kuturl', 'admin', 'favicon']) {
      const res = await create(apiKey, { url: 'https://example.com', alias });
      expect(res.status, alias).toBe(400);
      expect(res.body.message, alias).toBe('That alias is reserved, please choose another');
    }
  });

  it('rejects an alias that is not text', async () => {
    const { apiKey } = await makeKey();
    for (const alias of [123, null, ['abc'], {}, true]) {
      const res = await create(apiKey, { url: 'https://example.com', alias });
      expect(res.status, JSON.stringify(alias)).toBe(400);
    }
  });
});

describe('taken aliases', () => {
  it('answers 409 when an alias is taken, whoever asks, and leaves the first link alone', async () => {
    const first = await makeKey('first');
    const second = await makeKey('second');
    const alias = track(`taken-${stamp}`);

    const created = await create(first.apiKey, { url: 'https://example.com/original', alias });
    expect(created.status).toBe(201);

    const byOther = await create(second.apiKey, { url: 'https://example.com/other', alias });
    const bySame = await create(first.apiKey, { url: 'https://example.com/again', alias });
    for (const res of [byOther, bySame]) {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'alias_taken', message: 'That alias is already taken' });
    }

    const followed = await go(alias);
    expect(followed.status).toBe(302);
    expect(followed.headers.location).toBe('https://example.com/original');
    expect((await query('SELECT count(*)::int AS n FROM links WHERE code = $1', [alias])).rows[0].n).toBe(1);
  });

  it('treats aliases that differ only in letter case as the same alias', async () => {
    const { apiKey } = await makeKey();
    const alias = `Docs-${stamp}`;
    expect((await createAlias(apiKey, alias)).status).toBe(201);

    for (const variant of [`docs-${stamp}`, `DOCS-${stamp}`, `dOcS-${stamp}`]) {
      const res = await createAlias(apiKey, variant);
      expect(res.status, variant).toBe(409);
      expect(res.body.error).toBe('alias_taken');
    }
    expect((await go(alias)).status).toBe(302);
  });

  it('lets exactly one of six simultaneous requests claim an alias', async () => {
    const { apiKey } = await makeKey();
    const alias = track(`race-${stamp}`);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => create(apiKey, { url: `https://example.com/${i}`, alias }))
    );

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await query('SELECT count(*)::int AS n FROM links WHERE code = $1', [alias])).rows[0].n).toBe(1);
  });

  it('lets exactly one claim win when simultaneous requests differ only in letter case', async () => {
    const { apiKey } = await makeKey();
    const variants = [`Case-${stamp}`, `case-${stamp}`, `CASE-${stamp}`];

    const results = await Promise.all(variants.map((alias) => createAlias(apiKey, alias)));

    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    const { rows } = await query('SELECT count(*)::int AS n FROM links WHERE lower(code) = $1', [`case-${stamp}`]);
    expect(rows[0].n).toBe(1);
  });
});

describe('the cache', () => {
  it('makes a new alias work straight away, even after a 404 for the same address', async () => {
    const { apiKey } = await makeKey();
    const alias = track(`soon-${stamp}`);

    const before = await go(alias);
    expect(before.status).toBe(404);
    expect(JSON.parse(await redis.get(cacheKey(alias))).s).toBe('missing');

    expect((await createAlias(apiKey, alias)).status).toBe(201);

    const after = await go(alias);
    expect(after.status).toBe(302);
    expect(after.headers['x-cache']).toBe('HIT'); // the cached "missing" entry was overwritten
    expect(JSON.parse(await redis.get(cacheKey(alias))).s).toBe('active');
  });

  it('lets a deleted alias be claimed again, and redirects to the new owner at once', async () => {
    const first = await makeKey('first');
    const second = await makeKey('second');
    const alias = track(`reuse-${stamp}`);

    await create(first.apiKey, { url: 'https://example.com/old', alias });
    await go(alias);
    expect((await manage('delete', `/api/v1/links/${alias}`, first.apiKey)).status).toBe(204);
    expect((await go(alias)).status).toBe(404);

    const claimed = await create(second.apiKey, { url: 'https://example.com/new', alias });
    expect(claimed.status).toBe(201);

    const after = await go(alias);
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('https://example.com/new');
    expect(after.headers['x-cache']).toBe('HIT');
  });

  it('still creates the alias when the cache cannot be written', async () => {
    const { apiKey } = await makeKey();
    const alias = `nocache-${stamp}`;
    const set = vi.spyOn(redis, 'set').mockRejectedValue(new Error('redis is down'));

    const res = await createAlias(apiKey, alias);
    set.mockRestore();

    expect(res.status).toBe(201);
    expect(await rowFor(alias)).toBeDefined();
    expect((await go(alias)).status).toBe(302);
  });
});

describe('generated codes and aliases', () => {
  it('moves on to the next id when a generated code equals an existing alias', async () => {
    const { id, apiKey } = await makeKey();

    // Plant an alias that is exactly the code the next generated link would get
    const reserved = BigInt(await reserveLinkId());
    const planted = track(codes.encode(reserved + 1n));
    await insertLink({
      id: reserved,
      code: planted,
      longUrl: 'https://example.com/planted',
      apiKeyId: id,
      isCustom: true,
    });

    const res = await create(apiKey, { url: 'https://example.com/real' });
    track(res.body.code);

    expect(res.status).toBe(201);
    expect(res.body.code).not.toBe(planted);
    expect(res.body.code).toBe(codes.encode(reserved + 2n));
  });
});

describe('database rules', () => {
  it('enforces the alias shape in the database itself', async () => {
    const { id } = await makeKey();

    for (const code of ['ab', '-abc', 'abc-', `${'a'.repeat(33)}`]) {
      const error = await plantCustom(id, code).catch((e) => e);
      expect(error.code, code).toBe('23514'); // check violation
    }
  });

  it('applies the case-insensitive rule to aliases only', async () => {
    const { id, apiKey } = await makeKey();
    const base = `Mixed${stamp}`;

    // A generated-style (not custom) code does not take part in the alias rule
    const generated = await insertLink({
      id: await reserveLinkId(),
      code: track(base),
      longUrl: 'https://example.com',
      apiKeyId: id,
    });
    expect(generated.isCustom).toBe(false);

    const alias = await plantCustom(id, track(base.toLowerCase()));
    expect(alias.isCustom).toBe(true);

    // But a second alias that matches the first one in lower case is refused
    const clash = await plantCustom(id, track(base.toUpperCase())).catch((e) => e);
    expect(clash).toBeInstanceOf(CodeTakenError);
    expect(apiKey).toBeTruthy();
  });
});