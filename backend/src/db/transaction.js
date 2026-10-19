import pool from '../config/db.js';

// Runs fn inside one database transaction. Everything fn does through the client commits
// together, or rolls back together if anything throws.
export const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release(); // always give the connection back to the pool
  }
};