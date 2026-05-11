/**
 * One-shot migration: run schema-postgres.sql against Supabase.
 * Uses the DIRECT connection URL (port 5432) for migration/session-level features.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

  const DIRECT_URL = process.env.DATABASE_URL || process.env.DATABASE_URL_DIRECT;

async function main() {
  if (!DIRECT_URL) {
    console.error('DATABASE_URL_DIRECT not set in .env');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'schema-postgres.sql'), 'utf8');

  const client = new Client({ connectionString: DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to Supabase');

  try {
    await client.query(sql);
    console.log('Schema migration completed successfully');
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
