/**
 * files.js — File system browse routes.
 * Mounted at /files under requireAuth.
 * Admin+Manager full access; Workers see only own.
 */
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { requireAuth, requireAdmin, requireManager, setFlash } = require('../middleware/auth');
const filesService = require('../services/files');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const storage = require('../services/storage');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'files');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_FILES = 6;
const ALLOWED_MIMES = ['image/jpeg','image/png','image/webp','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed: ' + file.mimetype));
  }
});

const ENTITY_TYPES = [
  { key: 'customer', label: 'Customers', icon: '🏢', path: '/files/customers' },
  { key: 'vendor', label: 'Vendors', icon: '📦', path: '/files/vendors' },
  { key: 'worker', label: 'Workers', icon: '👤', path: '/files/workers' },
  { key: 'project', label: 'Projects', icon: '🔧', path: '/files/projects' },
  { key: 'global', label: 'Global', icon: '🌐', path: '/files/global' },
];

// GET /files — index showing 5 buckets
router.get('/', requireAuth, async (req, res) => {
  res.render('files/index', {
    title: 'Files',
    activeNav: 'files',
    buckets: ENTITY_TYPES,
  });
});

// GET /files/:entityType — list entities of that type with root folders
router.get('/:entityType', requireAuth, async (req, res) => {
  const entityType = req.params.entityType;
  const bucket = ENTITY_TYPES.find(b => b.key === entityType);
  if (!bucket) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Unknown entity type.' });

  // Workers: only see themselves
  if (entityType === 'worker' && req.session.userRole !== 'admin' && req.session.userRole !== 'manager') {
    // Redirect to self
    return res.redirect('/files/workers/' + req.session.userId);
  }

  const entities = filesService.getEntityList(entityType);
  const entitiesWithFolders = entities.map(e => {
    const folder = filesService.getRootFolder(entityType === 'project' ? 'work_order' : entityType === 'worker' ? 'user' : entityType, e.id);
    return { ...e, folder };
  });

  res.render('files/entities', {
    title: bucket.label,
    activeNav: 'files',
    bucket,
    entities: entitiesWithFolders,
  });
});

// GET /files/:entityType/:entityId — show root folder contents
router.get('/:entityType/:entityId', requireAuth, async (req, res) => {
  const entityType = req.params.entityType;
  const entityId = parseInt(req.params.entityId, 10);
  const mappedType = entityType === 'project' ? 'work_order' : entityType === 'worker' ? 'user' : entityType;

  const folder = filesService.getRootFolder(mappedType, entityId);
  if (!folder) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No files for this entity.' });
  }

  const contents = filesService.getFolderContents(folder.id);

  // Get entity name for display
  let entityName = '';
  if (entityType === 'customer') {
    const c = await db.get('SELECT name FROM customers WHERE id = ?', [entityId]);
    entityName = c ? c.name : 'Customer #' + entityId;
  } else if (entityType === 'vendor') {
    const v = await db.get('SELECT name FROM vendors WHERE id = ?', [entityId]);
    entityName = v ? v.name : 'Vendor #' + entityId;
  } else if (entityType === 'worker') {
    const u = await db.get('SELECT name FROM users WHERE id = ?', [entityId]);
    entityName = u ? u.name : 'Worker #' + entityId;
  } else if (entityType === 'project') {
    const wo = await db.get('SELECT display_number FROM work_orders WHERE id = ?', [entityId]);
    entityName = wo ? 'WO-' + wo.display_number : 'Project #' + entityId;
  } else if (entityType === 'global') {
    entityName = 'Global files';
  }

  res.render('files/folder', {
    title: entityName + ' - Files',
    activeNav: 'files',
    folder,
    contents,
    entityName,
    entityType,
    entityId,
  });
});

// GET /files/folders/:folderId — browse subfolder contents
router.get('/folders/:folderId', requireAuth, async (req, res) => {
  const folder = await db.get('SELECT * FROM folders WHERE id = ?', [req.params.folderId]);
  if (!folder) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Folder not found.' });
  const contents = filesService.getFolderContents(folder.id);
  res.render('files/folder', {
    title: folder.name + ' - Files',
    activeNav: 'files',
    folder,
    contents,
    entityName: folder.name,
    entityType: folder.entity_type,
    entityId: folder.entity_id,
  });
});

// POST /files/folders/:folderId/upload — upload files
router.post('/folders/:folderId/upload', requireAuth, requireManager, upload.array('files', MAX_FILES), async (req, res, next) => {
  const folder = await db.get('SELECT * FROM folders WHERE id = ?', [req.params.folderId]);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (!req.files || req.files.length === 0) {
    setFlash(req, 'error', 'No files selected.');
    return res.redirect('/files/folders/' + folder.id);
  }
  for (const file of req.files) {
    const ext = path.extname(file.originalname) || '';
    const key = `${folder.entity_type}/${folder.entity_id}/${crypto.randomUUID()}${ext}`;
    await storage.uploadBuffer('entity-files', key, file.buffer, file.mimetype);
    await db.run(`INSERT INTO files (folder_id, name, original_filename, storage_path, mime_type, size_bytes, uploaded_by_user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, now(), now())`,
      [folder.id, key, file.originalname, key, file.mimetype, file.size, req.session.userId]);
  }
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'file', entityId: folder.id, action: 'uploaded', before: null, after: { filename: req.files.map(f => f.originalname).join(', ') }, source: 'web', userId: req.session.userId });
  } catch(e) { /* audit best effort */ }
  setFlash(req, 'success', req.files.length + ' file(s) uploaded.');
  res.redirect('/files/folders/' + folder.id);
});

// POST /files/folders/:folderId/subfolder — create subfolder
router.post('/folders/:folderId/subfolder', requireAuth, requireManager, async (req, res) => {
  const folder = await db.get('SELECT * FROM folders WHERE id = ?', [req.params.folderId]);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const name = (req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Folder name required.'); return res.redirect('/files/folders/' + folder.id); }
  const r = await db.run(`INSERT INTO folders (parent_folder_id, name, entity_type, entity_id, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, now(), now())`,
    [folder.id, name, folder.entity_type, folder.entity_id, req.session.userId]);
  setFlash(req, 'success', 'Folder "' + name + '" created.');
  res.redirect('/files/folders/' + folder.id);
});

// POST /files/folders/:folderId/rename — rename folder (admin+)
router.post('/folders/:folderId/rename', requireAuth, requireAdmin, async (req, res) => {
  const folder = await db.get('SELECT * FROM folders WHERE id = ?', [req.params.folderId]);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const name = (req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Folder name required.'); return res.redirect('/files/folders/' + folder.id); }
  await db.run('UPDATE folders SET name=?, updated_at=datetime(\'now\') WHERE id=?', [name, folder.id]);
  setFlash(req, 'success', 'Folder renamed.');
  res.redirect('/files/folders/' + folder.id);
});

// POST /files/folders/:folderId/delete — delete folder (admin+, empty only)
router.post('/folders/:folderId/delete', requireAuth, requireAdmin, async (req, res) => {
  const folder = await db.get('SELECT * FROM folders WHERE id = ?', [req.params.folderId]);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const contents = filesService.getFolderContents(folder.id);
  if (contents.subfolders.length > 0 || contents.files.length > 0) {
    setFlash(req, 'error', 'Cannot delete non-empty folder.');
    return res.redirect('/files/folders/' + folder.id);
  }
  await db.run('DELETE FROM folders WHERE id=?', [folder.id]);
  setFlash(req, 'success', 'Folder deleted.');
  const parent = folder.parent_folder_id ? '/files/folders/' + folder.parent_folder_id : '/files';
  res.redirect(parent);
});

// POST /files/:id/delete — delete file (uploader or admin+)
router.post('/:id/delete', requireAuth, async (req, res) => {
  const file = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const isAdmin = req.session.userRole === 'admin';
  const isUploader = file.uploaded_by_user_id === req.session.userId;
  if (!isAdmin && !isUploader) return res.status(403).json({ error: 'Permission denied.' });
  try { await storage.remove('entity-files', file.storage_path || file.name); } catch(e) { /* best effort */ }
  await db.run('DELETE FROM files WHERE id=?', [file.id]);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'file', entityId: file.id, action: 'deleted', before: { filename: file.original_filename }, after: null, source: 'user', userId: req.session.userId });
  } catch(e) { /* audit best effort */ }
  setFlash(req, 'success', 'File deleted.');
  res.redirect('/files/folders/' + file.folder_id);
});

// GET /files/:id/view — inline preview via signed URL
router.get('/:id/view', requireAuth, async (req, res) => {
  const file = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'File not found.' });
  try {
    const signedUrl = await storage.getSignedUrl('entity-files', file.storage_path || file.name, 3600);
    return res.redirect(signedUrl);
  } catch (e) {
    return res.status(500).render('error', { title: 'Storage error', code: 500, message: 'Failed to access file: ' + e.message });
  }
});

// GET /files/:entityType/:entityId — show root folder contents
// (already defined above — route ordering ensures static routes run first)

module.exports = router;
