import { query } from '../config/db.js';

export const SQL = {
  totals: `SELECT
             coalesce(sum(clicks), 0)::bigint AS total,
             coalesce(sum(clicks) FILTER (WHERE hour >= $2), 0)::bigint AS last24,
             coalesce(sum(clicks) FILTER (WHERE hour >= $3), 0)::bigint AS last7,
             coalesce(sum(clicks) FILTER (WHERE hour >= $4), 0)::bigint AS last30
           FROM link_stats_hourly
           WHERE link_id = $1`,
  lastClick: `SELECT max(clicked_at) AS at FROM clicks WHERE link_id = $1`,
  series: `WITH counts AS (
             SELECT date_trunc($4, hour, 'UTC') AS at, sum(clicks)::bigint AS clicks
             FROM link_stats_hourly
             WHERE link_id = $1 AND hour >= $2 AND hour < $3
             GROUP BY 1
           )
           SELECT buckets.at, coalesce(counts.clicks, 0)::bigint AS clicks
           FROM generate_series($2::timestamptz, $3::timestamptz - $5::interval, $5::interval) AS buckets(at)
           LEFT JOIN counts ON counts.at = buckets.at
           ORDER BY buckets.at`,
  referrers: `SELECT referrer_host AS host, count(*)::bigint AS clicks
              FROM clicks
              WHERE link_id = $1 AND clicked_at >= $2 AND clicked_at < $3
              GROUP BY referrer_host
              ORDER BY clicks DESC, host ASC NULLS LAST
              LIMIT $4`,
  devices: `SELECT device, count(*)::bigint AS clicks
            FROM clicks
            WHERE link_id = $1 AND clicked_at >= $2 AND clicked_at < $3
            GROUP BY device`,
};

export const linkTotals = async (linkId, { since24h, since7d, since30d }, db = { query }) => {
  const [totals, last] = await Promise.all([
    db.query(SQL.totals, [linkId, since24h, since7d, since30d]),
    db.query(SQL.lastClick, [linkId]),
  ]);
  const row = totals.rows[0];
  return {
    total: Number(row.total),
    last24: Number(row.last24),
    last7: Number(row.last7),
    last30: Number(row.last30),
    lastClickAt: last.rows[0].at,
  };
};

export const clickSeries = async (linkId, { from, to, interval }, db = { query }) => {
  const { rows } = await db.query(SQL.series, [linkId, from, to, interval, `1 ${interval}`]);
  return rows.map((row) => ({ at: row.at, clicks: Number(row.clicks) }));
};

export const topReferrers = async (linkId, { from, to, limit }, db = { query }) => {
  const { rows } = await db.query(SQL.referrers, [linkId, from, to, limit]);
  return rows.map((row) => ({ host: row.host, clicks: Number(row.clicks) }));
};

export const deviceCounts = async (linkId, { from, to }, db = { query }) => {
  const { rows } = await db.query(SQL.devices, [linkId, from, to]);
  return Object.fromEntries(rows.map((row) => [row.device, Number(row.clicks)]));
};
