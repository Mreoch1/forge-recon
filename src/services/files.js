/**
 * files.js — File system service: root folder auto-creation, backfill.
 */
const db = require('../db/db');

async function ensureRootFolder(entityType, entityId, createdByUserId) {
  if (!entityType || !entityId) return null;
  const existing = await db.get('SELECT id FROM folders WHERE entity_type = ? AND entity_id = ? AND is_root = 1',
    [entityType, entityId]);
  if (existing) return existing.id;
  const r = await db.run(
    `INSERT INTO folders (name, entity_type, entity_id, is_root, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, now(), now())`,
    [entityType + '_' + entityId, entityType, entityId, createdByUserId || null]
  );
  return r.lastInsertRowid;
}

async function getRootFolder(entityType, entityId) {
  return await db.get('SELECT * FROM folders WHERE entity_type = ? AND entity_id = ? AND is_root = 1',
    [entityType, entityId]);
}

async function getFolderContents(folderId) {
  const subfolders = await db.all('SELECT * FROM folders WHERE parent_folder_id = ? ORDER BY name ASC', [folderId]);
  const files = await db.all('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC', [folderId]);
  return { subfolders, files };
}

async function getEntityList(entityType) {
  if (entityType === 'customer') {
    return await db.all('SELECT id, name FROM customers ORDER BY name ASC');
  }
  if (entityType === 'vendor') {
    return await db.all('SELECT id, name FROM vendors ORDER BY name ASC');
  }
  if (entityType === 'user' || entityType === 'worker') {
    return await db.all("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name ASC");
  }
  if (entityType === 'work_order' || entityType === 'project') {
    return await db.all('SELECT id, display_number AS name FROM work_orders ORDER BY id DESC');
  }
  return [];
}

module.exports = { ensureRootFolder, getRootFolder, getFolderContents, getEntityList };
