import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import env from '../src/config/env.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import spec from '../src/docs/openapi.js';
import { listOperations } from '../src/docs/renderDocs.js';
import healthRoutes from '../src/routes/healthRoutes.js';
import metricsRoutes from '../src/routes/metricsRoutes.js';
import docsRoutes from '../src/routes/docsRoutes.js';
import keysRoutes from '../src/routes/keysRoutes.js';
import linksRoutes from '../src/routes/linksRoutes.js';
import webhooksRoutes from '../src/routes/webhooksRoutes.js';
import redirectRoutes from '../src/routes/redirectRoutes.js';
import debugRoutes from '../src/routes/debugRoutes.js';
import { isReservedAlias } from '../src/utils/reservedAliases.js';
import { MAX_BULK_LINKS } from '../src/utils/validators.js';

const MOUNTS = [
  ['', healthRoutes],
  ['', metricsRoutes],
  ['', docsRoutes],
  ['', debugRoutes],
  ['/api/v1/keys', keysRoutes],
  ['/api/v1/links', linksRoutes],
  ['/api/v1/webhooks', webhooksRoutes],
  ['', redirectRoutes],
];
const UNDOCUMENTED = new Set(['GET /']);

const keyIds = [];
const codes = new Set();
let apiKey;

const realRoutes = () =>
  MOUNTS.flatMap(([mount, router]) =>
    router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods).map((method) => {
          const path = `${mount}${layer.route.path === '/' && mount ? '' : layer.route.path}`;
          return `${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`;
        })
      )
  ).filter((route) => !UNDOCUMENTED.has(route));

const documentedRoutes = () => listOperations(spec).map(({ method, path }) => `${method.toUpperCase()} ${path}`);

const resolveRef = (refPath) => refPath.replace('#/', '').split('/').reduce((node, key) => node?.[key], spec);

const allRefs = (node, found = []) => {
  if (Array.isArray(node)) node.forEach((item) => allRefs(item, found));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') found.push(value);
      else allRefs(value, found);
    }
  }
  return found;
};

beforeAll(async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'docs test' });
  apiKey = res.body.apiKey;
  keyIds.push(res.body.id);
});

afterAll(async () => {
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  if (codes.size > 0) await redis.del(...[...codes].map((code) => `link:${code}`));
  await closePool();
  await redis.quit();
});

describe('the OpenAPI document', () => {
  it('lists every router the app mounts', () => {
    const mounted = app.router.stack.filter((layer) => layer.handle?.stack).map((layer) => layer.handle);
    expect(new Set(mounted)).toEqual(new Set(MOUNTS.map(([, router]) => router)));
  });

  it('documents every route the app serves, and nothing it does not', () => {
    expect(documentedRoutes().sort()).toEqual(realRoutes().sort());
  });

  it('only points at schemas that exist', () => {
    const refs = allRefs(spec);
    expect(refs.length).toBeGreaterThan(10);
    for (const refPath of refs) expect(resolveRef(refPath), refPath).toBeDefined();
  });

  it('gives every operation a known tag, a summary and responses, and 401 when it needs a key', () => {
    const tags = new Set(spec.tags.map((tag) => tag.name));
    for (const { method, path, operation } of listOperations(spec)) {
      const name = `${method} ${path}`;
      expect(tags.has(operation.tags?.[0]), name).toBe(true);
      expect(operation.summary, name).toBeTruthy();
      expect(Object.keys(operation.responses).length, name).toBeGreaterThan(0);
      if (operation.security) expect(operation.responses[401], name).toBeDefined();
    }
  });

  it('describes the link fields the API really returns', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: 'https://example.com/documented' });
    codes.add(created.body.code);
    const details = await request(app).get(`/api/v1/links/${created.body.code}`).set('Authorization', `Bearer ${apiKey}`);

    const link = spec.components.schemas.Link;
    const detailFields = [...Object.keys(link.properties), ...Object.keys(spec.components.schemas.LinkDetails.allOf[1].properties)];
    expect(Object.keys(created.body).sort()).toEqual(Object.keys(link.properties).sort());
    expect(Object.keys(link.example).sort()).toEqual(Object.keys(link.properties).sort());
    expect(Object.keys(details.body).sort()).toEqual(detailFields.sort());
  });

  it('uses the same limits as the code', () => {
    const bulk = spec.paths['/api/v1/links/bulk'].post.requestBody.content['application/json'].schema;
    expect(bulk.properties.links.maxItems).toBe(MAX_BULK_LINKS);
  });

  it('is served as JSON with this deployment as the server', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.servers).toEqual([{ url: env.baseUrl }]);
    expect(Object.keys(res.body.paths).length).toBe(Object.keys(spec.paths).length);
  });
});

describe('the documentation page', () => {
  it('is a plain HTML page with every operation on it, and no scripts', async () => {
    const res = await request(app).get('/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).toContain('href="/openapi.json"');
    for (const { method, path } of listOperations(spec)) {
      expect(res.text, `${method} ${path}`).toContain(`<code>${path}</code>`);
    }
  });

  it('escapes what it prints', async () => {
    const res = await request(app).get('/docs');
    expect(res.text).not.toContain('<api');
    expect(res.text).toContain('&quot;url&quot;');
  });

  it('is what the site root opens', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/docs');
  });

  it('cannot be shadowed by an alias', () => {
    for (const word of ['docs', 'openapi', 'metrics', 'health', 'ping']) expect(isReservedAlias(word), word).toBe(true);
  });
});
