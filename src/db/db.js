/**
 * Dual-mode database wrapper: pg (Postgres) or sql.js (SQLite).
 * BOTH branches return Promises — every caller must await.
 *
 * Mode selection:
 *   USE_PG=1 + DATABASE_URL set  → pg mode
 *   otherwise                    → sql.js mode
 *
 * API: init, get, all, run, exec, transaction, persist, getMode, getPool
 */

const path = require('path');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ── pg mode ────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const USE_PG = process.env.USE_PG === '1';

let pgPool = null;

async function initPg() {
  const { Pool } = require('pg');
  const types = require('pg').types;
  types.setTypeParser(1700, val => parseFloat(val)); // NUMERIC → Number
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: false },
  });
  await pgPool.query('SELECT 1');
  console.log('[db] pg connected');
}

function rewriteSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function needsReturning(sql) {
  const s = sql.trim().toLowerCase();
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
    const txn = {
      get: async (s, p = []) => { const { rows } = await client.query(rewriteSql(s), p); return rows[0] || null; },
      all: async (s, p = []) => { const { rows } = await client.query(rewriteSql(s), p); return rows; },
      run: async (s, p = []) => {
        let q = rewriteSql(s);
        if (needsReturning(s)) q += ' RETURNING id';
        const { rowCount, rows } = await client.query(q, p);
        return { changes: rowCount, lastInsertRowid: rows && rows[0] ? rows[0].id : null };
      },
    };
    const result = await fn(txn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function pgPersist() {} // no-op

// ── sql.js mode (wraps sync work in Promise.resolve) ──────────────────────

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
    const flush = () => { if (_dirty) persistSync(); };
    process.on('SIGINT', () => { flush(); process.exit(0); });
    process.on('SIGTERM', () => { flush(); process.exit(0); });
    process.on('beforeExit', flush);
    _exitHooked = true;
  }
  return _db;
}

function persistSync() {
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
    if (_dirty) { try { persistSync(); } catch (e) { console.error('db persist failed:', e); } }
  }, 50);
}

function _ensureReady() {
  if (!_db) throw new Error('db.init() must be awaited before any query.');
}

function translateForSqlite(sql) {
  return sql
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/\bnow\(\)/gi, "datetime('now')")
    .replace(/\bcurrent_date\b/gi, "date('now')")
    .replace(/::date/gi, '')
    .replace(/::timestamp/gi, '')
    .replace(/to_char\((\S+),\s*'YYYY-MM'\)/gi, "strftime('%Y-%m', $1)")
    .replace(/to_char\((\S+),\s*'YYYY'\)/gi, "strftime('%Y', $1)")
    .replace(/\(\?::date\s*\+\s*(\d+)\)/g, "date(?, '+$1 days')")
    .replace(/current_date\s*-\s*(\d+)/gi, "date('now', '-$1 days')");
}

async function sqliteGet(sql, params = []) {
  _ensureReady();
  sql = translateForSqlite(sql);
  const stmt = _db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject();
    return null;
  } finally { stmt.free(); }
}

async function sqliteAll(sql, params = []) {
  _ensureReady();
  sql = translateForSqlite(sql);
  const stmt = _db.prepare(sql);
  const rows = [];
  try {
    if (params && params.length) stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally { stmt.free(); }
  return rows;
}

async function sqliteRun(sql, params = []) {
  _ensureReady();
  sql = translateForSqlite(sql);
  const stmt = _db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    stmt.step();
  } finally { stmt.free(); }
  const changes = _db.getRowsModified();
  let lastInsertRowid = null;
  const r = _db.exec('SELECT last_insert_rowid() AS id');
  if (r.length && r[0].values.length) lastInsertRowid = r[0].values[0][0];
  scheduleSave();
  return { changes, lastInsertRowid };
}

async function sqliteExec(sql) {
  _ensureReady();
  sql = translateForSqlite(sql);
  _db.exec(sql);
  scheduleSave();
}

async function sqliteTransaction(fn) {
  _ensureReady();
  _db.run('BEGIN');
  try {
    const txn = {
      get: (s, p) => sqliteGet(s, p),
      all: (s, p) => sqliteAll(s, p),
      run: (s, p) => sqliteRun(s, p),
    };
    const result = await fn(txn);
    _db.run('COMMIT');
    scheduleSave();
    return result;
  } catch (e) {
    try { _db.run('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

async function sqlitePersist() {
  persistSync();
}

// ── Mode selection ─────────────────────────────────────────────────────────

let _mode = null;

async function init() {
  if (_mode) return;
  if (USE_PG && DATABASE_URL) {
    _mode = 'pg';
    console.log('[db] mode: pg (Postgres)');
    await initPg();
  } else {
    _mode = 'sqlite';
    console.log('[db] mode: sql.js (SQLite)');
    await initSqlite();
  }
}

module.exports = {
  init,
  get:       (...args) => _mode === 'pg' ? pgGet(...args) : sqliteGet(...args),
  all:       (...args) => _mode === 'pg' ? pgAll(...args) : sqliteAll(...args),
  run:       (...args) => _mode === 'pg' ? pgRun(...args) : sqliteRun(...args),
  exec:      (...args) => _mode === 'pg' ? pgExec(...args) : sqliteExec(...args),
  transaction: (...args) => _mode === 'pg' ? pgTransaction(...args) : sqliteTransaction(...args),
  persist:   ()    => _mode === 'pg' ? pgPersist() : sqlitePersist(),
  getMode:   ()    => _mode,
  getPool:   ()    => pgPool,
};
