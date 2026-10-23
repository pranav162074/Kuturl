-- Up Migration

CREATE TABLE idempotency_keys (
  api_key_id       BIGINT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  key              TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done')),
  lock_token       UUID NOT NULL,
  locked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status  SMALLINT,
  response_body    JSON,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, key),
  CHECK ((status = 'done') = (response_status IS NOT NULL))
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Down Migration

DROP TABLE idempotency_keys;
