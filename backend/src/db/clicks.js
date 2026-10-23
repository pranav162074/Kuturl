import { query } from '../config/db.js';

const PARTITION_NAME = /^clicks_(\d{4})_(\d{2})$/;
const NO_PARTITION = '23514';

const ensuredMonths = new Set();

const monthOf = (date) => date.toISOString().slice(0, 7);

export const ensureClickPartition = async (at, db = { query }) => {
  const { rows } = await db.query('SELECT ensure_clicks_partition($1) AS name', [at]);
  ensuredMonths.add(monthOf(at));
  return rows[0].name;
};

const ensurePartitionsFor = async (events, db) => {
  for (const event of events) {
    if (!ensuredMonths.has(monthOf(event.clickedAt))) await ensureClickPartition(event.clickedAt, db);
  }
};

export const forgetEnsuredPartitions = () => ensuredMonths.clear();

export const recordClicks = async (events, db = { query }) => {
  if (events.length === 0) return 0;
  await ensurePartitionsFor(events, db);

  try {
    const { rows } = await db.query(
      `WITH events AS (
         SELECT *
         FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::text[], $5::text[])
           AS e(event_id, code, clicked_at, referrer_host, device)
       ),
       inserted AS (
         INSERT INTO clicks (event_id, link_id, clicked_at, referrer_host, device)
         SELECT e.event_id, l.id, e.clicked_at, e.referrer_host, e.device
         FROM events e
         JOIN links l ON l.code = e.code
         ON CONFLICT (event_id, clicked_at) DO NOTHING
         RETURNING link_id, clicked_at
       ),
       counted AS (
         INSERT INTO link_stats_hourly (link_id, hour, clicks)
         SELECT link_id, date_trunc('hour', clicked_at, 'UTC'), count(*)
         FROM inserted
         GROUP BY 1, 2
         ON CONFLICT (link_id, hour) DO UPDATE SET clicks = link_stats_hourly.clicks + EXCLUDED.clicks
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM inserted)::int AS inserted`,
      [
        events.map((e) => e.id),
        events.map((e) => e.code),
        events.map((e) => e.clickedAt.toISOString()),
        events.map((e) => e.referrerHost),
        events.map((e) => e.device),
      ]
    );
    return rows[0].inserted;
  } catch (error) {
    if (error.code === NO_PARTITION) forgetEnsuredPartitions();
    throw error;
  }
};

export const listClickPartitions = async (db = { query }) => {
  const { rows } = await db.query(
    `SELECT child.relname AS name
     FROM pg_inherits
     JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
     WHERE parent.relname = 'clicks'
     ORDER BY child.relname`
  );
  return rows.map((row) => row.name);
};

export const dropOldClickPartitions = async (keepMonths, now = new Date(), db = { query }) => {
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (keepMonths - 1), 1);
  const dropped = [];

  for (const name of await listClickPartitions(db)) {
    const match = PARTITION_NAME.exec(name);
    if (!match) continue;
    if (Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) >= cutoff) continue;

    await db.query(`DROP TABLE IF EXISTS "${name}"`);
    dropped.push(name);
  }

  if (dropped.length > 0) forgetEnsuredPartitions();
  return dropped;
};
