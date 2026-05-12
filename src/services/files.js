/**
 * files.js — File system service: root folder auto-creation, backfill.
 */
const db = require('../db/db');

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await db.init();
  await db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      is_root INTEGER NOT NULL DEFAULT 0,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      storage_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      uploaded_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_folders_entity ON folders(entity_type, entity_id, is_root)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)');
  schemaReady = true;
}

async function ensureRootFolder(entityType, entityId, createdByUserId) {
  await ensureSchema();
  if (!entityType || !entityId) return null;
  const existing = await db.get(
    'SELECT id FROM folders WHERE entity_type = ? AND entity_id = ? AND is_root = 1',
    [entityType, String(entityId)]
  );
  if (existing) return existing.id;
  const inserted = await db.run(`
    INSERT INTO folders (name, entity_type, entity_id, is_root, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, datetime('now'), datetime('now'))
  `, [entityType + '_' + entityId, entityType, String(entityId), createdByUserId || null]);
  return inserted.lastInsertRowid;
}

async function getRootFolder(entityType, entityId) {
  await ensureSchema();
  return db.get(
    'SELECT * FROM folders WHERE entity_type = ? AND entity_id = ? AND is_root = 1',
    [entityType, String(entityId)]
  );
}

async function getFolderContents(folderId) {
  await ensureSchema();
  const [subfolders, files] = await Promise.all([
    db.all('SELECT * FROM folders WHERE parent_folder_id = ? ORDER BY name', [folderId]),
    db.all('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC', [folderId]),
  ]);
  return { subfolders: subfolders || [], files: files || [] };
}

async function getEntityList(entityType) {
  await ensureSchema();
  if (entityType === 'customer') {
    return db.all('SELECT id, name FROM customers ORDER BY name');
  }
  if (entityType === 'vendor') {
    return db.all('SELECT id, name FROM vendors ORDER BY name');
  }
  if (entityType === 'user' || entityType === 'worker') {
    return db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name');
  }
  if (entityType === 'work_order' || entityType === 'project') {
    const rows = await db.all('SELECT id, display_number FROM work_orders ORDER BY id DESC');
    return (rows || []).map(r => ({ id: r.id, name: r.display_number }));
  }
  return [];
}

module.exports = { ensureSchema, ensureRootFolder, getRootFolder, getFolderContents, getEntityList };
