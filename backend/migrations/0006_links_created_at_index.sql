-- Up Migration

CREATE INDEX links_created_at_idx ON links (created_at);

-- Down Migration

DROP INDEX links_created_at_idx;
