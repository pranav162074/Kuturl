import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { closePool } from '../src/config/db.js';
import redis from '../src/config/redis.js';

afterAll(async () => {
  await closePool();
  await redis.quit();
});

describe('health endpoints', () => {
  it('answers /ping without touching any dependency', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('reports every dependency as ok on /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', postgres: 'ok', redis: 'ok' });
  });
});

describe('app basics', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/definitely/not/a/route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('turns malformed JSON into a 400, not a 500', async () => {
    const res = await request(app)
      .post('/anything')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('adds a request id, and keeps a sensible one from the client', async () => {
    const generated = await request(app).get('/ping');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const kept = await request(app).get('/ping').set('X-Request-Id', 'trace-abc-123');
    expect(kept.headers['x-request-id']).toBe('trace-abc-123');

    const replaced = await request(app).get('/ping').set('X-Request-Id', 'bad id with spaces!');
    expect(replaced.headers['x-request-id']).not.toBe('bad id with spaces!');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/ping');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});