-- Up Migration

ALTER TABLE links
  ADD COLUMN max_clicks INTEGER CHECK (max_clicks BETWEEN 1 AND 1000000000),
  ADD COLUMN limit_reached_at TIMESTAMPTZ;

CREATE TABLE webhook_endpoints (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  api_key_id   BIGINT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  url          TEXT NOT NULL CHECK (char_length(url) <= 2048),
  secret       TEXT NOT NULL,
  events       TEXT[] NOT NULL CHECK (cardinality(events) > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_endpoints_owner_idx ON webhook_endpoints (api_key_id);

CREATE TABLE webhook_deliveries (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id      BIGINT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id         UUID NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,
  last_status      INTEGER,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ,
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, id DESC);

-- Down Migration

DROP TABLE webhook_deliveries;
DROP TABLE webhook_endpoints;
ALTER TABLE links DROP COLUMN limit_reached_at, DROP COLUMN max_clicks;
