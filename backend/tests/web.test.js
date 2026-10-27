import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { isReservedAlias } from '../src/utils/reservedAliases.js';

const source = (name) => readFileSync(new URL(`../src/web/${name}`, import.meta.url), 'utf8');
const html = source('index.html');
const script = source('app.js');

afterAll(async () => {
  await closePool();
  await redis.quit();
});

describe('the web page', () => {
  it('is served at the site root', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toBe(html);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves its script and stylesheet with the right types', async () => {
    const js = await request(app).get('/static/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/^application\/javascript/);
    expect(js.text).toBe(script);

    const css = await request(app).get('/static/style.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
  });

  it('runs under the strict content security policy, with no inline script or handlers', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    const scripts = html.match(/<script\b[^>]*>/g);
    expect(scripts).toEqual(['<script src="/static/app.js" defer>']);
    expect(html).not.toMatch(/<script>[^<]/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('only looks up elements that exist on the page', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    const used = [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(30);
    for (const id of used) expect(ids.has(id), id).toBe(true);
  });

  it('never writes HTML from data, so link targets cannot inject markup', () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('only calls API routes that exist', () => {
    const paths = [...script.matchAll(/'\/api\/v1\/[a-z/]+'/g)].map((match) => match[0].slice(1, -1));
    expect(paths).toEqual(expect.arrayContaining(['/api/v1/keys', '/api/v1/links', '/api/v1/keys/me']));
    expect(script).toContain('`/api/v1/links/${encodeURIComponent(code)}`');
    for (const suffix of ['stats', 'stats/timeseries', 'stats/referrers', 'stats/devices', 'qr']) {
      expect(script).toContain(`\${base}/${suffix}`);
    }
  });

  it('cannot be shadowed by an alias', () => {
    expect(isReservedAlias('static')).toBe(true);
  });

  it('still answers unknown paths under /static with 404', async () => {
    const res = await request(app).get('/static/nothing.js');
    expect(res.status).toBe(404);
  });
});
