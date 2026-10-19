import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as migrate from 'node-pg-migrate';

const runner = migrate.runner ?? migrate.default;
const direction = process.argv[2] === 'down' ? 'down' : 'up';

// Migrations need a direct connection (no pooler). In CI there is only DATABASE_URL.
const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DIRECT_URL or DATABASE_URL must be set');
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

try {
  await runner({
    databaseUrl,
    dir,
    direction,
    // "up" applies everything pending, "down" undoes only the latest migration
    count: direction === 'down' ? 1 : Infinity,
    migrationsTable: 'pgmigrations',
  });
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
}