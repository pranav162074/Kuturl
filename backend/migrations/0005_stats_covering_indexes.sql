-- Up Migration

DROP INDEX clicks_link_time_idx;
CREATE INDEX clicks_link_time_idx ON clicks (link_id, clicked_at) INCLUDE (referrer_host, device);

ALTER TABLE link_stats_hourly
  DROP CONSTRAINT link_stats_hourly_pkey,
  ADD CONSTRAINT link_stats_hourly_pkey PRIMARY KEY (link_id, hour) INCLUDE (clicks);

-- Down Migration

ALTER TABLE link_stats_hourly
  DROP CONSTRAINT link_stats_hourly_pkey,
  ADD CONSTRAINT link_stats_hourly_pkey PRIMARY KEY (link_id, hour);

DROP INDEX clicks_link_time_idx;
CREATE INDEX clicks_link_time_idx ON clicks (link_id, clicked_at);
