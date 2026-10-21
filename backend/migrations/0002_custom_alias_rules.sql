-- Up Migration

-- Generated codes are always 7 characters, so these rules apply only to chosen aliases.
-- The application checks the same things, but the database is the last line of defence.
ALTER TABLE links
  ADD CONSTRAINT links_custom_code_shape
  CHECK (NOT is_custom OR code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$');

-- "Docs" and "docs" are different codes, but must not both be claimed as aliases.
-- The index is partial, so generated codes (which are random mixed case) are not affected.
CREATE UNIQUE INDEX links_custom_code_lower_idx ON links (lower(code)) WHERE is_custom;

-- Down Migration

DROP INDEX links_custom_code_lower_idx;
ALTER TABLE links DROP CONSTRAINT links_custom_code_shape;