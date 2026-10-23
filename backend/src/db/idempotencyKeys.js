import { query } from '../config/db.js';

export const WINDOW_HOURS = 24;
export const LOCK_TIMEOUT_SECONDS = 30;

const toRecord = (row) =>
  row && {
    requestHash: row.request_hash,
    status: row.status,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
  };

export const claimIdempotencyKey = async ({ apiKeyId, key, requestHash, token }, db = { query }) => {
  const { rows } = await db.query(
    `INSERT INTO idempotency_keys (api_key_id, key, request_hash, lock_token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (api_key_id, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           status = 'processing',
           lock_token = EXCLUDED.lock_token,
           locked_at = now(),
           response_status = NULL,
           response_body = NULL,
           created_at = now()
       WHERE idempotency_keys.created_at < now() - make_interval(hours => $5)
          OR (idempotency_keys.status = 'processing'
              AND idempotency_keys.request_hash = EXCLUDED.request_hash
              AND idempotency_keys.locked_at < now() - make_interval(secs => $6))
     RETURNING 1`,
    [apiKeyId, key, requestHash, token, WINDOW_HOURS, LOCK_TIMEOUT_SECONDS]
  );
  return rows.length === 1;
};

export const findIdempotencyKey = async (apiKeyId, key, db = { query }) => {
  const { rows } = await db.query(
    `SELECT request_hash, status, response_status, response_body, created_at
     FROM idempotency_keys
     WHERE api_key_id = $1 AND key = $2`,
    [apiKeyId, key]
  );
  return toRecord(rows[0]);
};

export const saveIdempotentResponse = async ({ apiKeyId, key, token, status, body }, db = { query }) => {
  const { rowCount } = await db.query(
    `UPDATE idempotency_keys
     SET status = 'done', response_status = $4, response_body = $5
     WHERE api_key_id = $1 AND key = $2 AND lock_token = $3 AND status = 'processing'`,
    [apiKeyId, key, token, status, JSON.stringify(body ?? null)]
  );
  return rowCount === 1;
};

export const releaseIdempotencyKey = async ({ apiKeyId, key, token }, db = { query }) => {
  const { rowCount } = await db.query(
    `DELETE FROM idempotency_keys
     WHERE api_key_id = $1 AND key = $2 AND lock_token = $3 AND status = 'processing'`,
    [apiKeyId, key, token]
  );
  return rowCount === 1;
};

export const deleteExpiredIdempotencyKeys = async (db = { query }) => {
  const { rowCount } = await db.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`,
    [WINDOW_HOURS]
  );
  return rowCount;
};
