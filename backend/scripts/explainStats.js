import 'dotenv/config';
import pg from 'pg';
import { SQL } from '../src/db/stats.js';

const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres']);
const url = process.env.DATABASE_URL;

if (!url || !SAFE_HOSTS.has(new URL(url).hostname)) {
  console.error('Refusing to run: this script writes about a million rows, so DATABASE_URL must be a local database.');
  process.exit(1);
}

const HOT_CLICKS = Number(process.env.HOT_CLICKS ?? 200_000);
const OTHER_LINKS = Number(process.env.OTHER_LINKS ?? 2_000);
const CLICKS_PER_OTHER = Number(process.env.CLICKS_PER_OTHER ?? 400);
const DAYS = 180;

const client = new pg.Client({ connectionString: url });
await client.connect();

const time = async (label, fn) => {
  const started = Date.now();
  const result = await fn();
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
};

const seed = async () => {
  await client.query(`DELETE FROM api_keys WHERE name = 'explain-stats'`);
  const { rows: [key] } = await client.query(
    `INSERT INTO api_keys (name, key_prefix, key_hash)
     VALUES ('explain-stats', 'kt_bench', md5(random()::text)) RETURNING id`
  );

  for (let day = 0; day <= DAYS + 31; day += 28) {
    await client.query(`SELECT ensure_clicks_partition(now() - make_interval(days => $1))`, [day]);
  }

  const { rows: links } = await client.query(
    `INSERT INTO links (code, long_url, api_key_id)
     SELECT 'bench' || lpad(n::text, 6, '0'), 'https://example.com/' || n, $1
     FROM generate_series(0, $2) AS n
     RETURNING id, code`,
    [key.id, OTHER_LINKS]
  );
  const hot = links.find((link) => link.code === 'bench000000');

  await client.query(
    `INSERT INTO clicks (event_id, link_id, clicked_at, referrer_host, device)
     SELECT gen_random_uuid(), link_id, clicked_at, referrer_host, device
     FROM (
       SELECT $1::bigint AS link_id, now() - random() * make_interval(days => $3) AS clicked_at,
              (ARRAY['google.com', 't.co', 'news.ycombinator.com', 'reddit.com', 'linkedin.com', NULL])[1 + floor(random() * 6)::int] AS referrer_host,
              (ARRAY['desktop', 'mobile', 'mobile', 'tablet', 'bot', 'other'])[1 + floor(random() * 6)::int] AS device
       FROM generate_series(1, $2)
       UNION ALL
       SELECT l.id, now() - random() * make_interval(days => $3),
              (ARRAY['google.com', 't.co', NULL])[1 + floor(random() * 3)::int], 'desktop'
       FROM links l, generate_series(1, $4)
       WHERE l.api_key_id = $5 AND l.id <> $1
     ) AS generated
     ORDER BY clicked_at`,
    [hot.id, HOT_CLICKS, DAYS, CLICKS_PER_OTHER, key.id]
  );

  await client.query(
    `INSERT INTO link_stats_hourly (link_id, hour, clicks)
     SELECT c.link_id, date_trunc('hour', c.clicked_at, 'UTC'), count(*)
     FROM clicks c JOIN links l ON l.id = c.link_id
     WHERE l.api_key_id = $1
     GROUP BY 1, 2
     ORDER BY 2, 1`,
    [key.id]
  );

  await client.query('VACUUM ANALYZE clicks');
  await client.query('VACUUM ANALYZE link_stats_hourly');
  return { keyId: key.id, hotId: hot.id };
};

const explain = async (label, text, params) => {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${text}`, params);
  const plan = rows.map((row) => row['QUERY PLAN']);
  const execution = plan.find((line) => line.startsWith('Execution Time'));
  console.log(`\n=== ${label} (${execution})\n${plan.join('\n')}`);
};

const reuse = async () => {
  const { rows } = await client.query(
    `SELECT k.id AS "keyId", l.id AS "hotId"
     FROM api_keys k JOIN links l ON l.api_key_id = k.id AND l.code = 'bench000000'
     WHERE k.name = 'explain-stats'`
  );
  if (!rows[0]) throw new Error('No seeded data to reuse. Run once with --keep first.');
  return rows[0];
};

const { keyId, hotId } = process.argv.includes('--reuse') ? await reuse() : await time('Seeding', seed);
const { rows: [size] } = await client.query(`SELECT count(*)::int AS n FROM clicks`);
console.log(`clicks in the database: ${size.n}, of which ${HOT_CLICKS} on the measured link`);

const now = new Date();
const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
const ago = (hours) => new Date(hourStart.getTime() - hours * 3_600_000);
const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const days = (n) => new Date(dayStart.getTime() - n * 86_400_000);

await explain('totals', SQL.totals, [hotId, ago(23), ago(7 * 24 - 1), ago(30 * 24 - 1)]);
await explain('last click', SQL.lastClick, [hotId]);
await explain('daily series, 30 days', SQL.series, [hotId, days(29), days(-1), 'day', '1 day']);
await explain('top referrers, 30 days', SQL.referrers, [hotId, days(30), now, 10]);
await explain('devices, 30 days', SQL.devices, [hotId, days(30), now]);
await explain('devices, 180 days', SQL.devices, [hotId, days(180), now]);

if (process.argv.includes('--keep') || process.argv.includes('--reuse')) {
  console.log('\nKept the seeded data (--keep).');
} else {
  await time('\nRemoving the seeded data', () => client.query('DELETE FROM api_keys WHERE id = $1', [keyId]));
}
await client.end();
