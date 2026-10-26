import { query } from '../config/db.js';
import { withTransaction } from './transaction.js';

const toEndpoint = (row) =>
  row && { id: row.id, url: row.url, events: row.events, createdAt: row.created_at, secret: row.secret };

const toDelivery = (row) =>
  row && {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    url: row.url,
    secret: row.secret,
  };

export class TooManyEndpointsError extends Error {}

export const createEndpoint = ({ apiKeyId, url, secret, events, max }) =>
  withTransaction(async (client) => {
    await client.query('SELECT id FROM api_keys WHERE id = $1 FOR UPDATE', [apiKeyId]);
    const { rows: [counted] } = await client.query(
      'SELECT count(*)::int AS n FROM webhook_endpoints WHERE api_key_id = $1',
      [apiKeyId]
    );
    if (counted.n >= max) throw new TooManyEndpointsError();

    const { rows } = await client.query(
      `INSERT INTO webhook_endpoints (api_key_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING *`,
      [apiKeyId, url, secret, events]
    );
    return toEndpoint(rows[0]);
  });

export const listEndpoints = async (apiKeyId, db = { query }) => {
  const { rows } = await db.query('SELECT * FROM webhook_endpoints WHERE api_key_id = $1 ORDER BY id', [apiKeyId]);
  return rows.map(toEndpoint);
};

export const findEndpoint = async (id, apiKeyId, db = { query }) => {
  const { rows } = await db.query('SELECT * FROM webhook_endpoints WHERE id = $1 AND api_key_id = $2', [id, apiKeyId]);
  return toEndpoint(rows[0]);
};

export const deleteEndpoint = async (id, apiKeyId, db = { query }) => {
  const { rowCount } = await db.query('DELETE FROM webhook_endpoints WHERE id = $1 AND api_key_id = $2', [id, apiKeyId]);
  return rowCount > 0;
};

export const enqueueEvent = async ({ apiKeyId, event, endpointId = null }, db = { query }) => {
  const { rows } = await db.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload)
     SELECT id, $2, $3, $4 FROM webhook_endpoints
     WHERE api_key_id = $1 AND ($5::bigint IS NULL AND $3 = ANY(events) OR id = $5)
     ON CONFLICT (endpoint_id, event_id) DO NOTHING
     RETURNING id`,
    [apiKeyId, event.id, event.type, JSON.stringify(event), endpointId]
  );
  return rows.length;
};

export const claimDueDeliveries = async ({ limit, leaseMs }, db = { query }) => {
  const { rows } = await db.query(
    `WITH due AS (
       SELECT id FROM webhook_deliveries
       WHERE status = 'pending' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
       ORDER BY next_attempt_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_deliveries d
     SET locked_until = now() + make_interval(secs => $2), attempts = d.attempts + 1
     FROM due, webhook_endpoints e
     WHERE d.id = due.id AND e.id = d.endpoint_id
     RETURNING d.*, e.url, e.secret`,
    [limit, leaseMs / 1000]
  );
  return rows.map(toDelivery);
};

export const finishDelivery = async (id, { status, lastStatus, lastError, nextAttemptAt = null }, db = { query }) => {
  await db.query(
    `UPDATE webhook_deliveries
     SET status = $2, last_status = $3, last_error = $4, locked_until = NULL,
         next_attempt_at = coalesce($5, next_attempt_at),
         delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END
     WHERE id = $1`,
    [id, status, lastStatus ?? null, lastError ?? null, nextAttemptAt]
  );
};

export const nextDueAt = async (db = { query }) => {
  const { rows } = await db.query(
    `SELECT min(greatest(next_attempt_at, coalesce(locked_until, next_attempt_at))) AS at
     FROM webhook_deliveries WHERE status = 'pending'`
  );
  return rows[0].at;
};

export const listDeliveries = async (endpointId, db = { query }) => {
  const { rows } = await db.query(
    'SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY id DESC LIMIT 50',
    [endpointId]
  );
  return rows.map(toDelivery);
};
