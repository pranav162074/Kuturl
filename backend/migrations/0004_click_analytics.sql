-- Up Migration

CREATE TABLE clicks (
  event_id       UUID NOT NULL,
  link_id        BIGINT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  clicked_at     TIMESTAMPTZ NOT NULL,
  referrer_host  TEXT CHECK (char_length(referrer_host) <= 253),
  device         TEXT NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'bot', 'other')),
  PRIMARY KEY (event_id, clicked_at)
) PARTITION BY RANGE (clicked_at);

CREATE INDEX clicks_link_time_idx ON clicks (link_id, clicked_at);

CREATE TABLE link_stats_hourly (
  link_id  BIGINT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  hour     TIMESTAMPTZ NOT NULL,
  clicks   BIGINT NOT NULL CHECK (clicks >= 0),
  PRIMARY KEY (link_id, hour)
);

CREATE FUNCTION ensure_clicks_partition(at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  month_start TIMESTAMP := date_trunc('month', at AT TIME ZONE 'UTC');
  partition_name TEXT := 'clicks_' || to_char(month_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF clicks FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(month_start + INTERVAL '1 month', 'YYYY-MM-DD') || ' 00:00:00+00'
  );
  RETURN partition_name;
EXCEPTION
  WHEN duplicate_table THEN
    RETURN partition_name;
END;
$$;

SELECT ensure_clicks_partition(now());
SELECT ensure_clicks_partition(now() + INTERVAL '1 month');

-- Down Migration

DROP TABLE link_stats_hourly;
DROP TABLE clicks;
DROP FUNCTION ensure_clicks_partition(TIMESTAMPTZ);
