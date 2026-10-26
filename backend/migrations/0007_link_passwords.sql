-- Up Migration

ALTER TABLE links ADD COLUMN password_hash TEXT CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%');

-- Down Migration

ALTER TABLE links DROP COLUMN password_hash;
