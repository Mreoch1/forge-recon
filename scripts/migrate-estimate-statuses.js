#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env' });

const { Client } = require('pg');

async function main() {
  const pgHost = process.env.POSTGRES_HOST;
  const pgUser = process.env.POSTGRES_USER || 'postgres';
  const pgPass = process.env.POSTGRES_PASSWORD;
  const pgDb = process.env.POSTGRES_DATABASE || 'postgres';
  const pgSsl = process.env.PGSSLMODE || 'require';

  if (!pgHost || !pgPass) {
    console.error('Missing POSTGRES_HOST or POSTGRES_PASSWORD. Pull prod env: vercel env pull .env.local --environment=production');
    process.exit(1);
  }

  const connStr = `postgres://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPass)}@${pgHost}:5432/${encodeURIComponent(pgDb)}?sslmode=${pgSsl}`;
  const client = new Client({ connectionString: connStr, connectionTimeoutMillis: 10000 });
  await client.connect();
  await client.query('ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check');
  await client.query("ALTER TABLE estimates ADD CONSTRAINT estimates_status_check CHECK (status IN ('new','draft','sent','pending','approved','accepted','rejected','expired'))");
  await client.end();
  console.log('Migration 006-estimate-statuses applied OK');
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
