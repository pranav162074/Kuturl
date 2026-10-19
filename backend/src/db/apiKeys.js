import { query } from '../config/db.js';

const toApiKey = (row) =>
  row && {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };

// Only the hash is stored. The key itself is shown to its owner once and never saved.
export const createApiKey = async ({ name, keyPrefix, keyHash }, db = { query }) => {
  const { rows } = await db.query(
    `INSERT INTO api_keys (name, key_prefix, key_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name, key_prefix, created_at, revoked_at`,
    [name, keyPrefix, keyHash]
  );
  return toApiKey(rows[0]);
};

// A revoked key must stop working immediately, so lookups skip revoked rows
export const findActiveApiKeyByHash = async (keyHash, db = { query }) => {
  const { rows } = await db.query(
    `SELECT id, name, key_prefix, created_at, revoked_at
     FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash]
  );
  return toApiKey(rows[0]);
};