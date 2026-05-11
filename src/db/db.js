/**
 * Dual-mode database wrapper: pg (Postgres via DATABASE_URL) or sql.js (SQLite).
 *
 * Auto-detects mode from env:
 *   DATABASE_URL set  → pg mode (production / staging)
 *   USE_SQLITE=1       → sql.js mode (local dev, offline fallback)
 *   Neither set        → sql.js mode (legacy local dev)
 *
 * Exports same API surface: init, get, all, run, exec, transaction, persist.
 * Existing route code requires NO changes — only the bottom layer swaps.
 */

const path = require('path');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ── pg mode ────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const USE_SQLITE = process.env.USE_SQLITE === '1';

let pgPool = null;

async function initPg() {
  const { Pool } = require('pg');
  const types = require('pg').types;
  // NUMERIC → Number (OID 1700)
  types.setTypeParser(1700, val => parseFloat(val));
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: false },  // Supabase requires SSL
  });
  // Test connection
  await pgPool.query('SELECT 1');
  console.log('[db] pg connected');
  return pgPool;
}

function rewriteSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Reverse-translate pg-native SQL syntax back to sql.js-compatible SQLite.
 * Source files now use pg syntax after 22a migration. This lets USE_SQLITE=1
 * fallback still work without reverting source files.
 */
function translateForSqlite(sql) {
  return sql
    // ILIKE → LIKE (pg case-insensitive → sqlite case-insensitive)
    .replace(/\bILIKE\b/gi, 'LIKE')
    // now() → datetime('now')
    .replace(/\bnow\(\)/gi, "datetime('now')")
    // current_date → date('now')
    .replace(/\bcurrent_date\b/gi, "date('now')")
    // ::date cast → date() function
    .replace(/::date/gi, '')
    // ::timestamp cast → no-op for sql.js TEXT storage
    .replace(/::timestamp/gi, '')
    // to_char(x, 'YYYY-MM') → strftime('%Y-%m', x)
    .replace(/to_char\((\S+),\s*'YYYY-MM'\)/gi, "strftime('%Y-%m', $1)")
    // to_char(x, 'YYYY') → strftime('%Y', x)
    .replace(/to_char\((\S+),\s*'YYYY'\)/gi, "strftime('%Y', $1)")
    // (?::date + N) → date(?, '+N days')
    .replace(/\(\?::date\s*\+\s*(\d+)\)/g, "date(?, '+$1 days')")
    // current_date - N → date('now', '-N days')
    .replace(/current_date\s*-\s*(\d+)/gi, "date('now', '-$1 days')");
}

function needsReturning(sql) {
  const s = sql.trim().toLowerCase();
  // Only add RETURNING id for INSERT statements that don't already have it
  return s.startsWith('insert') && !/returning\b/i.test(sql);
}

async function pgGet(sql, params = []) {
  const { rows } = await pgPool.query(rewriteSql(sql), params);
  return rows[0] || null;
}

async function pgAll(sql, params = []) {
  const { rows } = await pgPool.query(rewriteSql(sql), params);
  return rows;
}

async function pgRun(sql, params = []) {
  let query = rewriteSql(sql);
  if (needsReturning(sql)) query += ' RETURNING id';
  const { rowCount, rows } = await pgPool.query(query, params);
  return { changes: rowCount, lastInsertRowid: rows && rows[0] ? rows[0].id : null };
}

async function pgExec(sql) {
  await pgPool.query(sql);
}

async function pgTransaction(fn) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      get: async (s, p = []) => {
        const { rows } = await client.query(rewriteSql(s), p);
        return rows[0] || null;
      },
      all: async (s, p = []) => {
        const { rows } = await client.query(rewriteSql(s), p);
        return rows;
      },
      run: async (s, p = []) => {
        let query = rewriteSql(s);
        if (needsReturning(s)) query += ' RETURNING id';
        const { rowCount, rows } = await client.query(query, p);
        return { changes: rowCount, lastInsertRowid: rows && rows[0] ? rows[0].id : null };
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function pgPersist() {
  // no-op — Postgres persists itself
}

// ── sql.js mode ────────────────────────────────────────────────────────────

const initSqlJs = require('sql.js');
const fs = require('fs');
const DB_PATH = path.join(DATA_DIR, 'app.db');

let SQL = null;
let _db = null;
let _dirty = false;
let _saveTimer = null;
let _exitHooked = false;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function initSqlite() {
  if (_db) return _db;
  SQL = await initSqlJs();
  ensureDir(DATA_DIR);
  let buf;
  if (fs.existsSync(DB_PATH)) buf = fs.readFileSync(DB_PATH);
  _db = new SQL.Database(buf);
  _db.run('PRAGMA foreign_keys = ON;');

  if (!_exitHooked) {
    const flush = () => { if (_dirty) persist(); };
    process.on('SIGINT', () => { flush(); process.exit(0); });
    process.on('SIGTERM', () => { flush(); process.exit(0); });
    process.on('beforeExit', flush);
    _exitHooked = true;
  }
  return _db;
}

function persistSqlite() {
  if (!_db) return;
  ensureDir(DATA_DIR);
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  _dirty = false;
}

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_dirty) {
      try { persistSqlite(); }
      catch (e) { console.error('db persist failed:', e); }
    }
  }, 50);
}

function _ensureReady() {
  if (!_db) throw new Error('db.init() must be awaited before any query.');
}

function sqliteGet(sql, params = []) {
  _ensureReady();
  sql = translateForSqlite(sql);
  const stmt = _db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject();
    return null;
  } finally {
    stmt.free();
  }
}

function sqliteAll(sql, params = []) {
  _ensureReady();
  sql = translateForSqlite(sql);
  const stmt = _db.prepare(sql);
  const rows = [];
  try {
    if (params && params.length) stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function sqliteRun(sql, params = []) {
  _ensureReady();
  sql = translateForSqlite(sql);
  const stmt = _db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
  const changes = _db.getRowsModified();
  let lastInsertRowid = null;
  const r = _db.exec('SELECT last_insert_rowid() AS id');
  if (r.length && r[0].values.length) lastInsertRowid = r[0].values[0][0];
  scheduleSave();
  return { changes, lastInsertRowid };
}

function sqliteExec(sql) {
  _ensureReady();
  sql = translateForSqlite(sql);
  _db.exec(sql);
  scheduleSave();
}

function sqliteTransaction(fn) {
  _ensureReady();
  _db.run('BEGIN');
  try {
    const r = fn();
    _db.run('COMMIT');
    scheduleSave();
    return r;
  } catch (e) {
    try { _db.run('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// ── Mode selection ─────────────────────────────────────────────────────────

let _mode = null; // 'pg' or 'sqlite'

async function init() {
  if (_mode) return;
  if (DATABASE_URL && !USE_SQLITE) {
    _mode = 'pg';
    console.log('[db] mode: pg (Postgres via DATABASE_URL)');
    await initPg();
  } else {
    _mode = 'sqlite';
    console.log('[db] mode: sql.js (SQLite local — USE_SQLITE=1 or no DATABASE_URL)');
    await initSqlite();
  }
}

module.exports = {
  init,
  get:      (...args) => _mode === 'pg' ? pgGet(...args) : sqliteGet(...args),
  all:      (...args) => _mode === 'pg' ? pgAll(...args) : sqliteAll(...args),
  run:      (...args) => _mode === 'pg' ? pgRun(...args) : sqliteRun(...args),
  exec:     (...args) => _mode === 'pg' ? pgExec(...args) : sqliteExec(...args),
  transaction: (...args) => _mode === 'pg' ? pgTransaction(...args) : sqliteTransaction(...args),
  persist:  () => _mode === 'pg' ? pgPersist() : persistSqlite(),
  getMode:  () => _mode,
  getPool:  () => pgPool,
};
