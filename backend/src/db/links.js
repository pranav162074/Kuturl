import { query } from '../config/db.js';
import { CodeTakenError } from './errors.js';

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
  };

// Short codes are derived from the id, so the id has to exist before the insert.
// nextval never hands the same number out twice, even across app instances.
export const reserveLinkId = async (db = { query }) => {
  const { rows } = await db.query(`SELECT nextval('links_id_seq') AS id`);
  return rows[0].id;
};

export const insertLink = async (link, db = { query }) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO links (id, code, long_url, api_key_id, is_custom, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [link.id, link.code, link.longUrl, link.apiKeyId, link.isCustom ?? false, link.expiresAt ?? null]
    );
    return toLink(rows[0]);
  } catch (error) {
    // 23505 is Postgres's "unique violation". The database is the judge of whether a
    // code is free, which is the only check that stays correct under concurrent requests.
    if (error.code === '23505' && error.constraint === 'links_code_key') {
      throw new CodeTakenError(link.code);
    }
    throw error;
  }
};

export const findLinkByCode = async (code, db = { query }) => {
  const { rows } = await db.query(`SELECT * FROM links WHERE code = $1`, [code]);
  return toLink(rows[0]);
};