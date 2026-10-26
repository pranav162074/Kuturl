import { query } from '../config/db.js';
import { CodeTakenError } from './errors.js';

// Both indexes mean "that code is taken": the exact one, and the case-insensitive one for aliases
const CODE_CONFLICTS = new Set(['links_code_key', 'links_custom_code_lower_idx']);
// BIGINT columns come back from pg as strings, because JavaScript numbers lose precision
// above 2^53. Ids stay strings all the way through the app for that reason.
const toLink = (row) =>
  row && {
    id: row.id,
    code: row.code,
    longUrl: row.long_url,
    apiKeyId: row.api_key_id,
    isCustom: row.is_custom,
    expiresAt: row.expires_at,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    passwordHash: row.password_hash ?? null,
    maxClicks: row.max_clicks ?? null,
    limitReachedAt: row.limit_reached_at ?? null,
  };

// Short codes are derived from the id, so the id has to exist before the insert.
// nextval never hands the same number out twice, even across app instances.
export const reserveLinkId = async (db = { query }) => {
  const { rows } = await db.query(`SELECT nextval('links_id_seq') AS id`);
  return rows[0].id;
};

export const reserveLinkIds = async (count, db = { query }) => {
  const { rows } = await db.query(`SELECT nextval('links_id_seq') AS id FROM generate_series(1, $1)`, [count]);
  return rows.map((row) => row.id);
};

export const insertLinks = async (links, db = { query }) => {
  if (links.length === 0) return [];
  const { rows } = await db.query(
    `INSERT INTO links (id, code, long_url, api_key_id, is_custom, expires_at, password_hash, max_clicks)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::boolean[], $6::timestamptz[], $7::text[], $8::int[])
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      links.map((link) => link.id),
      links.map((link) => link.code),
      links.map((link) => link.longUrl),
      links.map((link) => link.apiKeyId),
      links.map((link) => link.isCustom ?? false),
      links.map((link) => link.expiresAt ?? null),
      links.map((link) => link.passwordHash ?? null),
      links.map((link) => link.maxClicks ?? null),
    ]
  );
  return rows.map(toLink);
};

export const insertLink = async (link, db = { query }) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO links (id, code, long_url, api_key_id, is_custom, expires_at, password_hash, max_clicks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        link.id,
        link.code,
        link.longUrl,
        link.apiKeyId,
        link.isCustom ?? false,
        link.expiresAt ?? null,
        link.passwordHash ?? null,
        link.maxClicks ?? null,
      ]
    );
    return toLink(rows[0]);
  } catch (error) {
    // 23505 is Postgres's "unique violation". The database is the judge of whether a
    // code is free, which is the only check that stays correct under concurrent requests.
    if (error.code === '23505' && CODE_CONFLICTS.has(error.constraint)) {
      throw new CodeTakenError(link.code);
    }
    throw error;
  }
};

export const findLinkByCode = async (code, db = { query }) => {
  const { rows } = await db.query(`SELECT * FROM links WHERE code = $1`, [code]);
  return toLink(rows[0]);
};

// A link that belongs to someone else is indistinguishable from one that doesn't exist
export const findOwnedLink = async (code, apiKeyId, db = { query }) => {
  const { rows } = await db.query(`SELECT * FROM links WHERE code = $1 AND api_key_id = $2`, [code, apiKeyId]);
  return toLink(rows[0]);
};

// Keyset pagination: "links older than this id". Ids only grow, and the index on
// (api_key_id, id DESC) already stores them in that order, so every page costs the same.
// The SQL is built from fixed fragments plus numbered placeholders, never from user input.
export const listLinksByOwner = async (apiKeyId, { limit, cursor }, db = { query }) => {
  const params = [apiKeyId];
  let where = 'api_key_id = $1';
  if (cursor) {
    params.push(cursor);
    where += ` AND id < $${params.length}`;
  }
  params.push(limit + 1); // one extra row tells us whether another page exists

  const { rows } = await db.query(
    `SELECT * FROM links WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return { links: rows.slice(0, limit).map(toLink), hasMore: rows.length > limit };
};

// changes may contain: disabled (boolean) and expiresAt (a Date, or null to remove it)
export const updateOwnedLink = async (code, apiKeyId, changes, db = { query }) => {
  const sets = [];
  const params = [code, apiKeyId];

  if ('disabled' in changes) {
    // COALESCE keeps the original time if the link was already disabled
    sets.push(changes.disabled ? 'disabled_at = COALESCE(disabled_at, now())' : 'disabled_at = NULL');
  }
  if ('expiresAt' in changes) {
    params.push(changes.expiresAt);
    sets.push(`expires_at = $${params.length}`);
  }
  if ('passwordHash' in changes) {
    params.push(changes.passwordHash);
    sets.push(`password_hash = $${params.length}`);
  }
  if ('maxClicks' in changes) {
    params.push(changes.maxClicks);
    sets.push(`max_clicks = $${params.length}`, 'limit_reached_at = NULL');
  }
  if (sets.length === 0) return findOwnedLink(code, apiKeyId, db);

  const { rows } = await db.query(
    `UPDATE links SET ${sets.join(', ')} WHERE code = $1 AND api_key_id = $2 RETURNING *`,
    params
  );
  return toLink(rows[0]);
};

export const deleteOwnedLink = async (code, apiKeyId, db = { query }) => {
  const { rows } = await db.query(`DELETE FROM links WHERE code = $1 AND api_key_id = $2 RETURNING id, max_clicks`, [
    code,
    apiKeyId,
  ]);
  return rows[0] ? { id: rows[0].id, maxClicks: rows[0].max_clicks } : null;
};