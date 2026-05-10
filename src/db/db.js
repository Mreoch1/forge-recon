/**
 * sql.js wrapper that gives us a better-sqlite3-style API on top of the
 * pure-JS SQLite implementation. Why sql.js: no native deps, no VS C++
 * build tools required (decision in DECISIONS.md).
 *
 * Usage:
 *   const db = require('./db');
 *   await db.init();
 *   const u = db.get('SELECT * FROM users WHERE id = ?', [1]);
 *   const us = db.all('SELECT * FROM users');
 *   const r = db.run('INSERT INTO users (...) VALUES (...)', [...]);
 *   db.transaction(() => { ... });
 *
 * Persistence: sql.js holds the DB in memory. We persist to data/app.db
 * after writes (debounced 50ms) and on process exit. Reads are cheap;
 * writes pay one fs.writeFileSync per debounced batch.
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

let SQL = null;
let _db = null;
let _dirty = false;
let _saveTimer = null;
let _exitHooked = false;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function init() {
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

function persist() {
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
      try { persist(); }
      catch (e) { console.error('db persist failed:', e); }
    }
  }, 50);
}

function _ensureReady() {
  if (!_db) throw new Error('db.init() must be awaited before any query.');
}

/** Execute a write statement. Returns { changes, lastInsertRowid }. */
function run(sql, params = []) {
  _ensureReady();
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

/** Single-row read. Returns object or null. */
function get(sql, params = []) {
  _ensureReady();
  const stmt = _db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject();
    return null;
  } finally {
    stmt.free();
  }
}

/** Multi-row read. Returns array of objects. */
function all(sql, params = []) {
  _ensureReady();
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

/** Run multiple semicolon-separated statements. No params. Used for schema. */
function exec(sql) {
  _ensureReady();
  _db.exec(sql);
  scheduleSave();
}

/** Wrap fn() in BEGIN/COMMIT. Rolls back on throw. */
function transaction(fn) {
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

module.exports = { init, run, get, all, exec, transaction, persist };
