#!/usr/bin/env node
/**
 * pg-exec.js — Synchronous pg query executor for child_process.execSync usage.
 *
 * Usage: node pg-exec.js <json-payload>
 *   json-payload = { sql: "...", params: [...], returning: true/false }
 *
 * Outputs: { result: ..., error: null } or { result: null, error: "..." }
 *
 * Environment: reads DATABASE_URL from process.env (dotenv loaded by caller).
 */
const fs = require('fs');
const path = require('path');

// Load .env from project root
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const payload = JSON.parse(process.argv[2] || '{}');
const { sql, params, action } = payload;

if (!sql && action !== 'ping') {
  console.error(JSON.stringify({ error: 'No SQL provided' }));
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(JSON.stringify({ error: 'DATABASE_URL not set' }));
  process.exit(1);
}

async function main() {
  const { Pool } = require('pg');
  const types = require('pg').types;
  types.setTypeParser(1700, val => parseFloat(val)); // NUMERIC → Number

  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    if (action === 'ping') {
      await pool.query('SELECT 1');
      console.log(JSON.stringify({ result: 'ok' }));
      return;
    }

    if (action === 'exec') {
      await pool.query(sql);
      console.log(JSON.stringify({ result: { changes: 0 } }));
      return;
    }

    if (action === 'get') {
      const { rows } = await pool.query(sql, params || []);
      console.log(JSON.stringify({ result: rows[0] || null }));
      return;
    }

    if (action === 'all') {
      const { rows } = await pool.query(sql, params || []);
      console.log(JSON.stringify({ result: rows }));
      return;
    }

    if (action === 'run') {
      let query = sql;
      // Rewrite ? → $N
      let i = 0;
      query = query.replace(/\?/g, () => `$${++i}`);
      // Add RETURNING id for INSERT if needed
      if (query.trim().toLowerCase().startsWith('insert') && !/returning\b/i.test(query)) {
        query += ' RETURNING id';
      }
      const { rowCount, rows } = await pool.query(query, params || []);
      console.log(JSON.stringify({
        result: { changes: rowCount, lastInsertRowid: rows && rows[0] ? rows[0].id : null }
      }));
      return;
    }

    console.error(JSON.stringify({ error: 'Unknown action: ' + action }));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
