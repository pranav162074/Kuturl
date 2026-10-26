import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { clearRenderedQrCodes } from '../src/services/qrCodes.js';

const keyIds = [];
const codes = new Set();

let owner;
let stranger;

const makeKey = async (name) => {
  const res = await request(app).post('/api/v1/keys').send({ name });
  keyIds.push(res.body.id);
  return res.body.apiKey;
};

const makeLink = async (body = {}) => {
  const res = await request(app)
    .post('/api/v1/links')
    .set('Authorization', `Bearer ${owner}`)
    .send({ url: 'https://example.com/printed', ...body });
  codes.add(res.body.code);
  return res.body;
};

const qr = (code, params = '', apiKey = owner) =>
  request(app)
    .get(`/api/v1/links/${code}/qr${params}`)
    .set('Authorization', `Bearer ${apiKey}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

const decodePng = (buffer) => {
  const image = PNG.sync.read(buffer);
  const result = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  return { text: result?.data ?? null, width: image.width, height: image.height };
};

const metric = async (labels) => {
  const text = (await request(app).get('/metrics')).text;
  const line = text.split('\n').find((l) => l.startsWith(`kuturl_qr_codes_total{${labels}}`));
  return line ? Number(line.split(' ').at(-1)) : 0;
};

beforeAll(async () => {
  owner = await makeKey('qr owner');
  stranger = await makeKey('qr stranger');
});

beforeEach(() => {
  clearRenderedQrCodes();
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('QR codes', () => {
  it('needs the owner key, and hides other people links', async () => {
    const { code } = await makeLink();
    expect((await request(app).get(`/api/v1/links/${code}/qr`)).status).toBe(401);
    expect((await qr(code, '', stranger)).status).toBe(404);
    expect((await qr('zzzzzzz')).status).toBe(404);
    expect((await qr('bad.code')).status).toBe(404);
  });

  it('returns an SVG by default, sized as asked', async () => {
    const { code } = await makeLink();
    const res = await qr(code);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    const svg = res.body.toString('utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="512"');
    expect(svg).toContain('viewBox=');
    expect(svg).not.toMatch(/<script|on\w+=/i);
    expect(res.headers['content-disposition']).toBe(`inline; filename="kuturl-${code}.svg"`);
  });

  it('returns a PNG that decodes to the short link', async () => {
    const { code, shortUrl } = await makeLink();
    const res = await qr(code, '?format=png&size=300');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const decoded = decodePng(res.body);
    expect(decoded.text).toBe(shortUrl);
    expect(decoded.width).toBe(300);
    expect(decoded.height).toBe(300);
  });

  it('decodes at every error correction level, the smallest size and no margin', async () => {
    const { code, shortUrl } = await makeLink();
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      expect(decodePng((await qr(code, `?format=png&ecc=${ecc}`)).body).text, ecc).toBe(shortUrl);
    }
    expect(decodePng((await qr(code, '?format=png&size=128&margin=0')).body).text).toBe(shortUrl);
  });

  it('works for custom aliases and for disabled links', async () => {
    const alias = `qr-${Date.now().toString(36)}`;
    const { shortUrl } = await makeLink({ alias });
    expect(decodePng((await qr(alias, '?format=png')).body).text).toBe(shortUrl);

    await request(app).patch(`/api/v1/links/${alias}`).set('Authorization', `Bearer ${owner}`).send({ disabled: true });
    expect((await qr(alias, '?format=png')).status).toBe(200);
  });

  it('gives the same strong ETag for the same picture, and a new one when anything changes', async () => {
    const { code } = await makeLink();
    const first = await qr(code, '?format=png&size=256');
    const again = await qr(code, '?format=png&size=256');

    expect(first.headers.etag).toMatch(/^"qr-[0-9a-f]{32}"$/);
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(again.body.equals(first.body)).toBe(true);

    const variants = ['?format=svg&size=256', '?format=png&size=257', '?format=png&size=256&margin=3', '?format=png&size=256&ecc=H'];
    const tags = await Promise.all(variants.map(async (params) => (await qr(code, params)).headers.etag));
    expect(new Set([first.headers.etag, ...tags]).size).toBe(5);

    const other = await makeLink();
    expect((await qr(other.code, '?format=png&size=256')).headers.etag).not.toBe(first.headers.etag);
  });

  it('answers 304 with no body when the client already has it, without rendering', async () => {
    const { code } = await makeLink();
    const first = await qr(code, '?format=png');
    const rendered = await metric('format="png",result="rendered"');

    const cached = await qr(code, '?format=png').set('If-None-Match', first.headers.etag);

    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
    expect(await metric('format="png",result="rendered"')).toBe(rendered);
    expect(await metric('format="png",result="not_modified"')).toBeGreaterThanOrEqual(1);
  });

  it('renders again for a stale ETag', async () => {
    const { code } = await makeLink();
    const res = await qr(code).set('If-None-Match', '"qr-00000000000000000000000000000000"');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('keeps recent renders in memory', async () => {
    const { code } = await makeLink();
    await qr(code, '?format=png');
    const before = await metric('format="png",result="memory"');
    await qr(code, '?format=png');
    expect(await metric('format="png",result="memory"')).toBe(before + 1);
  });

  it('lets only the owner browser cache it', async () => {
    const { code } = await makeLink();
    const res = await qr(code);
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers.vary).toMatch(/Authorization/);
  });

  it('rejects options it does not support', async () => {
    const { code } = await makeLink();
    const cases = [
      ['?format=gif', 'format must be svg or png'],
      ['?size=127', 'size must be at least 128'],
      ['?size=1025', 'size must be at most 1024'],
      ['?size=300.5', 'size must be a whole number'],
      ['?size=big', 'size must be a number'],
      ['?margin=11', 'margin must be at most 10'],
      ['?margin=-1', 'margin must be at least 0'],
      ['?ecc=X', 'ecc must be L, M, Q or H'],
    ];
    for (const [params, message] of cases) {
      const res = await qr(code, params);
      expect(res.status, params).toBe(400);
      expect(JSON.parse(res.body.toString()).message, params).toBe(message);
    }
    expect((await qr(code, '?colour=red')).status).toBe(400);
  });
});
