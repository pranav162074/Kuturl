-- Up Migration

-- Who is allowed to create links. The key itself is never stored, only its SHA-256 hash.
-- The prefix is the first few characters, so a key can be recognised in lists and logs.
CREATE TABLE api_keys (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  key_prefix  TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- Short codes are derived from this sequence (the encoding is built in the next branch).
-- A sequence hands out unique numbers with no collisions and no retries, even when many
-- app instances insert at the same time.
CREATE SEQUENCE links_id_seq AS BIGINT;

CREATE TABLE links (
  id           BIGINT PRIMARY KEY DEFAULT nextval('links_id_seq'),
  code         TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$'),
  long_url     TEXT NOT NULL CHECK (char_length(long_url) <= 2048),
  api_key_id   BIGINT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  is_custom    BOOLEAN NOT NULL DEFAULT false,
  expires_at   TIMESTAMPTZ,
  disabled_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sequence is dropped automatically if the table is
ALTER SEQUENCE links_id_seq OWNED BY links.id;

-- "List my links, newest first, page by page" without sorting: ids only grow, so
-- the index already holds each owner's links in order
CREATE INDEX links_owner_idx ON links (api_key_id, id DESC);

-- Down Migration

DROP TABLE links;
DROP TABLE api_keys;