import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { query, closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';
import { createRedisConnection } from '../src/config/redisConnection.js';
import settings from '../src/config/webhooks.js';
import { enqueueEvent } from '../src/db/webhooks.js';
import { deliver, verifySignature, signPayload } from '../src/services/webhookSender.js';
import { createWebhookDispatcher, retryDelayFor, maxAttempts } from '../src/worker/webhookDispatcher.js';
import { counterKey } from '../src/services/clickLimits.js';

const original = { ...settings };
const keyIds = [];
const touched = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let receiver;
let receiverUrl;
let received = [];
let respond = (req, res) => res.writeHead(200).end('ok');

const makeKey = async () => {
  const res = await request(app).post('/api/v1/keys').send({ name: 'webhook test' });
  keyIds.push(res.body.id);
  return { id: res.body.id, apiKey: res.body.apiKey };
};

const register = (apiKey, body) => request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${apiKey}`).send(body);

const api = (method, path, apiKey) => request(app)[method](path).set('Authorization', `Bearer ${apiKey}`);

const waitFor = async (check, timeoutMs = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
};

const deliveryRows = async (endpointId) =>
  (await query('SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY id', [endpointId])).rows;

const queueTest = async (apiKey, endpointId) => (await api('post', `/api/v1/webhooks/${endpointId}/test`, apiKey)).body;

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
});

beforeEach(async () => {
  settings.allowPrivateTargets = true;
  received = [];
  respond = (req, res) => res.writeHead(200).end('ok');
  await query(`UPDATE webhook_deliveries SET status = 'failed' WHERE status = 'pending'`);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(settings, original);
});

afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  const ids = (await query('SELECT id FROM links WHERE api_key_id = ANY($1::bigint[])', [keyIds])).rows.map((r) => counterKey(r.id));
  await query('DELETE FROM api_keys WHERE id = ANY($1::bigint[])', [keyIds]);
  const keys = [...[...touched].map((code) => `link:${code}`), ...ids];
  if (keys.length > 0) await redis.del(...keys);
  await closePool();
  await redis.quit();
});

describe('registering endpoints', () => {
  it('returns a signing secret once, and never again', async () => {
    const { apiKey } = await makeKey();
    const res = await register(apiKey, { url: `${receiverUrl}/hook` });

    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(res.body.events).toEqual(['link.click_limit_reached']);
    expect(res.headers['cache-control']).toBe('no-store');

    const list = await api('get', '/api/v1/webhooks', apiKey);
    expect(list.body.endpoints).toEqual([{ id: res.body.id, url: `${receiverUrl}/hook`, events: ['link.click_limit_reached'], createdAt: res.body.createdAt }]);
    expect(JSON.stringify(list.body)).not.toContain('whsec_');
  });

  it('allows five endpoints per API key', async () => {
    const { apiKey } = await makeKey();
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await register(apiKey, { url: `${receiverUrl}/${i}` })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 409]);
  });

  it('only accepts https URLs to public addresses in production mode', async () => {
    settings.allowPrivateTargets = false;
    const { apiKey } = await makeKey();
    const cases = [
      [{ url: 'http://hooks.example.com/x' }, 'url must be a full https:// address'],
      [{ url: 'https://localhost/x' }, 'Webhooks cannot be sent to private or internal addresses'],
      [{ url: 'https://10.0.0.5/x' }, 'Webhooks cannot be sent to private or internal addresses'],
      [{ url: 'https://169.254.169.254/latest/meta-data' }, 'Webhooks cannot be sent to private or internal addresses'],
      [{ url: 'https://user:pass@hooks.example.com/x' }, 'url must not contain a username or password'],
      [{ url: 'not a url' }, 'url must be a full https:// address'],
      [{ url: 'https://hooks.example.com/x', events: ['link.deleted'] }, 'events can only contain link.click_limit_reached'],
      [{ url: 'https://hooks.example.com/x', events: [] }, 'events must contain at least one event'],
    ];
    for (const [body, message] of cases) {
      const res = await register(apiKey, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.message, JSON.stringify(body)).toBe(message);
    }
    expect((await register(apiKey, { url: 'https://hooks.example.com/kuturl' })).status).toBe(201);
  });

  it('keeps endpoints private to their owner, and deletes them with their deliveries', async () => {
    const owner = await makeKey();
    const other = await makeKey();
    const { id } = (await register(owner.apiKey, { url: `${receiverUrl}/mine` })).body;
    await queueTest(owner.apiKey, id);

    expect((await api('delete', `/api/v1/webhooks/${id}`, other.apiKey)).status).toBe(404);
    expect((await api('post', `/api/v1/webhooks/${id}/test`, other.apiKey)).status).toBe(404);
    expect((await api('get', `/api/v1/webhooks/${id}/deliveries`, other.apiKey)).status).toBe(404);
    expect((await api('delete', '/api/v1/webhooks/abc', owner.apiKey)).status).toBe(404);

    expect((await api('delete', `/api/v1/webhooks/${id}`, owner.apiKey)).status).toBe(204);
    expect(await deliveryRows(id)).toHaveLength(0);
  });
});

describe('delivering events', () => {
  it('signs each delivery so the receiver can verify it', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/signed` })).body;
    const { eventId } = await queueTest(apiKey, endpoint.id);

    const result = await createWebhookDispatcher().runOnce();

    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
    expect(received).toHaveLength(1);
    const [hit] = received;
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/signed');
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['user-agent']).toBe('Kuturl-Webhooks/1.0');
    expect(hit.headers['kuturl-event-id']).toBe(eventId);
    expect(hit.headers['kuturl-event-type']).toBe('webhook.test');
    expect(verifySignature(endpoint.secret, hit.body, hit.headers['kuturl-signature'])).toBe(true);
    expect(JSON.parse(hit.body)).toMatchObject({ id: eventId, type: 'webhook.test', data: { endpointId: endpoint.id } });

    const [row] = await deliveryRows(endpoint.id);
    expect(row).toMatchObject({ status: 'delivered', attempts: 1, last_status: 200 });
  });

  it('delivers the click limit event for the right link', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/limits` })).body;
    const link = (await api('post', '/api/v1/links', apiKey).send({ url: 'https://example.com/popular', maxClicks: 2 })).body;
    touched.add(link.code);

    await request(app).get(`/${link.code}`);
    await request(app).get(`/${link.code}`);
    await waitFor(async () => (await deliveryRows(endpoint.id)).length === 1);
    await createWebhookDispatcher().runOnce();

    expect(received).toHaveLength(1);
    const event = JSON.parse(received[0].body);
    expect(event.type).toBe('link.click_limit_reached');
    expect(event.data.link).toMatchObject({ code: link.code, shortUrl: link.shortUrl, maxClicks: 2 });
    expect(verifySignature(endpoint.secret, received[0].body, received[0].headers['kuturl-signature'])).toBe(true);
  });

  it('retries a failed delivery later with the same event, then succeeds', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/flaky` })).body;
    const { eventId } = await queueTest(apiKey, endpoint.id);
    respond = (req, res) => res.writeHead(500).end('boom');

    const before = Date.now();
    expect(await createWebhookDispatcher().runOnce()).toMatchObject({ retried: 1 });
    let [row] = await deliveryRows(endpoint.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: 500, last_error: 'Endpoint answered 500' });
    const wait = new Date(row.next_attempt_at).getTime() - before;
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThan(40_000);

    expect((await createWebhookDispatcher().runOnce()).claimed).toBe(0);

    respond = (req, res) => res.writeHead(204).end();
    await query('UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1', [row.id]);
    expect(await createWebhookDispatcher().runOnce()).toMatchObject({ delivered: 1 });
    [row] = await deliveryRows(endpoint.id);
    expect(row).toMatchObject({ status: 'delivered', attempts: 2, last_status: 204 });
    expect(received.map((hit) => hit.headers['kuturl-event-id'])).toEqual([eventId, eventId]);
  });

  it('waits longer after each failure, and gives up after the last attempt', async () => {
    expect(settings.retryDelaysMs).toEqual([...settings.retryDelaysMs].sort((a, b) => a - b));
    for (let attempt = 1; attempt <= settings.retryDelaysMs.length; attempt += 1) {
      const base = settings.retryDelaysMs[attempt - 1];
      expect(retryDelayFor(attempt, () => 0)).toBe(Math.round(base * 0.8));
      expect(retryDelayFor(attempt, () => 1)).toBe(Math.round(base * 1.2));
    }

    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/dead` })).body;
    await queueTest(apiKey, endpoint.id);
    await query('UPDATE webhook_deliveries SET attempts = $2 WHERE endpoint_id = $1', [endpoint.id, maxAttempts() - 1]);
    respond = (req, res) => res.writeHead(503).end();

    expect(await createWebhookDispatcher().runOnce()).toMatchObject({ failed: 1 });
    expect((await deliveryRows(endpoint.id))[0]).toMatchObject({ status: 'failed', attempts: maxAttempts() });
  });

  it('treats a timeout or a redirect as a failure', async () => {
    const { apiKey } = await makeKey();
    const slow = (await register(apiKey, { url: `${receiverUrl}/slow` })).body;
    const moved = (await register(apiKey, { url: `${receiverUrl}/moved` })).body;
    settings.timeoutMs = 200;
    respond = (req, res) => {
      if (req.url === '/moved') res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    };
    await queueTest(apiKey, slow.id);
    await queueTest(apiKey, moved.id);

    expect(await createWebhookDispatcher().runOnce()).toMatchObject({ claimed: 2, retried: 2 });
    expect((await deliveryRows(slow.id))[0].last_error).toBe('No response within 200 ms');
    expect((await deliveryRows(moved.id))[0]).toMatchObject({ last_status: 302, last_error: 'Endpoint answered 302' });
    expect(received.filter((hit) => hit.url !== '/slow' && hit.url !== '/moved')).toHaveLength(0);
  });

  it('never sends the same delivery twice when dispatchers run side by side', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/parallel` })).body;
    for (let i = 0; i < 12; i += 1) await queueTest(apiKey, endpoint.id);

    const results = await Promise.all([1, 2, 3].map(() => createWebhookDispatcher().runOnce()));

    expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(12);
    expect(received).toHaveLength(12);
    expect(new Set(received.map((hit) => hit.headers['kuturl-event-id'])).size).toBe(12);
  });

  it('picks up a delivery whose dispatcher crashed mid-way, once its lease runs out', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/lease` })).body;
    await queueTest(apiKey, endpoint.id);
    await query(`UPDATE webhook_deliveries SET attempts = 1, locked_until = now() + interval '1 minute' WHERE endpoint_id = $1`, [endpoint.id]);

    expect((await createWebhookDispatcher().runOnce()).claimed).toBe(0);
    await query(`UPDATE webhook_deliveries SET locked_until = now() - interval '1 second' WHERE endpoint_id = $1`, [endpoint.id]);
    expect(await createWebhookDispatcher().runOnce()).toMatchObject({ delivered: 1 });
  });

  it('wakes up as soon as an event is queued, without polling the database', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/nudged` })).body;
    const dispatcher = createWebhookDispatcher({ subscriber: createRedisConnection('Test webhook Redis') });
    await dispatcher.start();
    try {
      await sleep(200);
      await queueTest(apiKey, endpoint.id);
      expect(await waitFor(() => received.length === 1, 2000)).toBe(true);
    } finally {
      await dispatcher.stop();
    }
  });

  it('lists recent deliveries without the secret', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/history` })).body;
    await queueTest(apiKey, endpoint.id);
    await createWebhookDispatcher().runOnce();

    const res = await api('get', `/api/v1/webhooks/${endpoint.id}/deliveries`, apiKey);
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0]).toMatchObject({ eventType: 'webhook.test', status: 'delivered', attempts: 1, lastStatus: 200, nextAttemptAt: null });
    expect(JSON.stringify(res.body)).not.toContain('whsec_');
  });

  it('queues each event only once per endpoint', async () => {
    const { id: apiKeyId, apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/once` })).body;
    const event = { id: randomUUID(), type: 'link.click_limit_reached', createdAt: new Date().toISOString(), data: {} };

    expect(await enqueueEvent({ apiKeyId, event })).toBe(1);
    expect(await enqueueEvent({ apiKeyId, event })).toBe(0);
    expect(await deliveryRows(endpoint.id)).toHaveLength(1);
  });

  it('counts delivery results', async () => {
    const { apiKey } = await makeKey();
    const endpoint = (await register(apiKey, { url: `${receiverUrl}/counted` })).body;
    const read = async (result) => {
      const text = (await request(app).get('/metrics')).text;
      const line = text.split('\n').find((l) => l.startsWith(`kuturl_webhook_deliveries_total{result="${result}"}`));
      return line ? Number(line.split(' ').at(-1)) : 0;
    };
    const before = await read('delivered');
    await queueTest(apiKey, endpoint.id);
    await createWebhookDispatcher().runOnce();
    expect((await read('delivered')) - before).toBe(1);
  });
});

describe('protection against server-side request forgery', () => {
  const attempt = (url) => deliver({ url, secret: 'whsec_x', body: '{}', eventId: randomUUID(), eventType: 'webhook.test' });

  it('refuses private and loopback addresses, even though they were allowed at registration', async () => {
    settings.allowPrivateTargets = false;
    for (const url of [receiverUrl, `http://localhost:${receiver.address().port}`, 'http://[::1]:9/', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/']) {
      const result = await attempt(url);
      expect(result.ok, url).toBe(false);
      expect(result.error, url).toBe('Webhook target resolves to a private or reserved address');
    }
    expect(received).toHaveLength(0);
  });

  it('checks the address the hostname actually resolves to', async () => {
    settings.allowPrivateTargets = false;
    const { apiKey } = await makeKey();
    settings.allowPrivateTargets = true;
    const endpoint = (await register(apiKey, { url: `http://localhost:${receiver.address().port}/rebind` })).body;
    settings.allowPrivateTargets = false;
    await queueTest(apiKey, endpoint.id);

    expect(await createWebhookDispatcher().runOnce()).toMatchObject({ retried: 1 });
    expect((await deliveryRows(endpoint.id))[0].last_error).toBe('Webhook target resolves to a private or reserved address');
    expect(received).toHaveLength(0);
  });
});

describe('signatures', () => {
  const secret = 'whsec_test-secret';
  const body = JSON.stringify({ hello: 'world' });

  it('verifies a fresh, untouched delivery', () => {
    const now = Date.now();
    const header = signPayload(secret, body, Math.floor(now / 1000));
    expect(verifySignature(secret, body, header, { now })).toBe(true);
  });

  it('rejects a changed body, the wrong secret, an old timestamp or a malformed header', () => {
    const now = Date.now();
    const header = signPayload(secret, body, Math.floor(now / 1000));
    expect(verifySignature(secret, `${body} `, header, { now })).toBe(false);
    expect(verifySignature('whsec_other', body, header, { now })).toBe(false);
    expect(verifySignature(secret, body, header, { now: now + 301_000 })).toBe(false);
    expect(verifySignature(secret, body, 'v1=abc', { now })).toBe(false);
    expect(verifySignature(secret, body, undefined, { now })).toBe(false);
  });
});
