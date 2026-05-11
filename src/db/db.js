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

// ── pg mode (deferred — see Round 27) ─────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const USE_SQLITE = process.env.USE_SQLITE === '1';

async function initPg() {
  throw new Error(
    'Postgres deployment deferred to Round 27. ' +
    'Set USE_SQLITE=1 in .env or remove DATABASE_URL to use sql.js.'
  );
}

function pgGet() { throw new Error('pg mode disabled — Round 27'); }
function pgAll() { throw new Error('pg mode disabled — Round 27'); }
function pgRun() { throw new Error('pg mode disabled — Round 27'); }
function pgExecMulti() { throw new Error('pg mode disabled — Round 27'); }
function pgTransaction() { throw new Error('pg mode disabled — Round 27'); }

function pgPersist() {
  // no-op — Postgres persists itself
}

/**
 * Reverse-translate pg-native SQL syntax back to sql.js-compatible SQLite.
 * Source files now use pg syntax after 22a migration. This translateForSqlite
 * lets sql.js mode work without reverting the source files.
 */
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
  // Default: sql.js. Only use pg when explicitly opted in via USE_PG=1.
  if (DATABASE_URL && process.env.USE_PG === '1') {
    _mode = 'pg';
    console.log('[db] mode: pg (Postgres via DATABASE_URL — Round 27 preview)');
    await initPg();
  } else {
    _mode = 'sqlite';
    console.log('[db] mode: sql.js (SQLite local — USE_SQLITE=1 or default)');
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
