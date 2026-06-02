/**
 * files.js — File system browse routes.
 * Mounted at /files under requireAuth.
 * Admin+Manager full access; Workers see only own.
 *
 * Route ordering is CRITICAL: specific /folders/* routes
 * must be declared BEFORE the generic /:entityType/:entityId
 * route, otherwise Express matches /files/folders/123 against
 * /:entityType/:entityId first (with entityType="folders").
 */
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireAdmin, requireManager, setFlash } = require('../middleware/auth');
const filesService = require('../services/files');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const mime = require('mime-types');
const storage = require('../services/storage');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_ZIP_SIZE = 200 * 1024 * 1024; // 200MB
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

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const zipMimes = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip' && zipMimes.includes(file.mimetype)) cb(null, true);
    else if (ext === '.zip') cb(null, true); // accept zip even if mime is unknown
    else cb(new Error('Only .zip files allowed.'));
  }
});

const ENTITY_TYPES = [
  { key: 'vendor', label: 'Vendors', icon: '📦', path: '/files/vendors' },
  { key: 'contractor', label: 'Contractors', icon: '👷', path: '/files/contractors' },
  { key: 'worker', label: 'Workers', icon: '👤', path: '/files/workers' },
  { key: 'project', label: 'Projects', icon: '🔧', path: '/files/projects' },
  { key: 'global', label: 'Global', icon: '🌐', path: '/files/global' },
];

function isWorker(req) {
  return req.session?.role === 'worker';
}

function workerForbidden(res) {
  return res.status(403).render('error', {
    title: 'Forbidden',
    code: 403,
    message: 'Workers can only access their own worker files and assigned work-order files.'
  });
}

function workerCanAccessEntity(req, entityType, entityId) {
  if (!isWorker(req)) return true;
  if (entityType === 'worker' || entityType === 'user') return Number(entityId) === Number(req.session.userId);
  return false;
}

function normalizeEntityType(value) {
  const normalized = String(value || '').replace(/s$/, '').replace(/-/g, '_');
  if (normalized === 'work_order') return 'project';
  return normalized;
}

function assertFileRouteRead(result, label) {
  if (result?.error) {
    const err = new Error(`${label}: ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }
  return result || {};
}

async function checkedFileRouteRead(query, label) {
  return assertFileRouteRead(await query, label);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// GET / — index showing 5 buckets
router.get('/', requireAuth, async (req, res) => {
  if (isWorker(req)) return res.redirect('/files/workers/' + req.session.userId);

  // D-142: Project bucket removed from the /files/ index — users access project
  // files through the project page (the Files tile on /projects/:id, D-141).
  // ENTITY_TYPES stays intact because the entity_type='project' mapping is still
  // used internally for the per-project file area at /files/projects/:id.
  const visibleBuckets = ENTITY_TYPES.filter(b => b.key !== 'project');

  res.render('files/index', {
    title: 'Files',
    activeNav: 'files',
    buckets: visibleBuckets,
  });
});

// GET /:entityType — list entities of that type with root folders
// Normalizes plural paths (e.g. /files/customers → entityType='customer')
router.get('/:entityType', requireAuth, async (req, res) => {
  const entityType = normalizeEntityType(req.params.entityType);
  // D-142: /files/projects (no id) redirects to /projects — users navigate from
  // the project page's Files tile. The deep route /files/projects/:id still works.
  if (entityType === 'project') return res.redirect(302, '/projects');
  const bucket = ENTITY_TYPES.find(b => b.key === entityType);
  if (!bucket) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Unknown entity type.' });

  // Workers: only see themselves.
  if (isWorker(req) && entityType !== 'worker') return workerForbidden(res);
  if (entityType === 'worker' && isWorker(req)) {
    return res.redirect('/files/workers/' + req.session.userId);
  }

  const entities = await filesService.getEntityList(entityType);
  const entitiesWithFolders = await Promise.all(entities.map(async e => {
    const folder = await filesService.getRootFolder(
      entityType === 'project' ? 'work_order' : entityType === 'worker' ? 'user' : entityType,
      e.id
    );
    return { ...e, folder };
  }));

  res.render('files/entities', {
    title: bucket.label,
    activeNav: 'files',
    bucket,
    entities: entitiesWithFolders,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPECIFIC ROUTES (declare before generic /:entityType/:entityId)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /folders/:folderId — browse subfolder contents
router.get('/folders/:folderId', requireAuth, async (req, res) => {
  const { data: folder } = await checkedFileRouteRead(supabase.from('folders').select('*').eq('id', req.params.folderId).maybeSingle(), 'file folder read failed');
  if (!folder) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Folder not found.' });
  if (!workerCanAccessEntity(req, folder.entity_type, folder.entity_id)) return workerForbidden(res);
  const contents = await filesService.getFolderContents(folder.id);
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

// POST /folders/:folderId/upload — upload files
router.post('/folders/:folderId/upload', requireAuth, requireManager, upload.array('files', MAX_FILES), async (req, res, next) => {
  const { data: folder } = await checkedFileRouteRead(supabase.from('folders').select('*').eq('id', req.params.folderId).maybeSingle(), 'file upload folder read failed');
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (!req.files || req.files.length === 0) {
    setFlash(req, 'error', 'No files selected.');
    return res.redirect('/files/folders/' + folder.id);
  }
  for (const file of req.files) {
    const originalName = file.originalname;
    const ext = path.extname(file.originalname) || '';
    const key = `${folder.entity_type}/${folder.entity_id}/${crypto.randomUUID()}${ext}`;
    await storage.uploadBuffer('entity-files', key, file.buffer, file.mimetype);
    const { error: fileInsertErr } = await supabase.from('files').insert({
      folder_id: folder.id, name: originalName, original_filename: originalName,
      storage_path: key, mime_type: file.mimetype, size_bytes: file.size,
      uploaded_by_user_id: req.session.userId || null,
    });
    if (fileInsertErr) throw fileInsertErr;
  }
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'file', entityId: folder.id, action: 'uploaded', before: null, after: { filename: req.files.map(f => f.originalname).join(', ') }, source: 'user', userId: req.session.userId });
  } catch(e) { /* audit best effort */ }
  setFlash(req, 'success', req.files.length + ' file(s) uploaded.');
  res.redirect('/files/folders/' + folder.id);
});

// ── Zip-based folder structure upload ─────────────────────────────────────────

router.post('/folders/:folderId/upload-zip', requireAuth, requireManager, uploadZip.single('archive'), async (req, res, next) => {
  const { data: folder } = await checkedFileRouteRead(
    supabase.from('folders').select('*').eq('id', req.params.folderId).maybeSingle(),
    'zip upload folder read failed'
  );
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (!req.file) {
    setFlash(req, 'error', 'No .zip file selected.');
    return res.redirect('/files/folders/' + folder.id);
  }

  const entityType = folder.entity_type;
  const entityId = folder.entity_id;
  const userId = req.session.userId || null;
  const uploaded = { folders: 0, files: 0, errors: [] };
  const pathToFolderId = {}; // maps normalized path => folder id

  try {
    const zip = await JSZip.loadAsync(req.file.buffer);

    // Collect entries, sort so directories come before their contents
    const entries = [];
    zip.forEach((relPath, zipEntry) => {
      // Skip macOS junk, hidden files, and root-level __MACOSX
      const parts = relPath.split('/').filter(Boolean);
      if (parts.some(p => p === '__MACOSX' || p.startsWith('.'))) return;
      if (relPath.endsWith('/')) return; // directories handled by creating folders from file paths
      entries.push({ relPath, parts, zipEntry });
    });

    // Collect all unique folder paths from file paths
    const allFolderPaths = new Set();
    for (const e of entries) {
      for (let i = 1; i < e.parts.length; i++) {
        allFolderPaths.add(e.parts.slice(0, i).join('/'));
      }
    }

    // Create folders bottom-up (parent first), skip root (.)
    const sortedFolders = [...allFolderPaths].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const fp of sortedFolders) {
      const parent = fp.split('/').slice(0, -1).join('/');
      const name = fp.split('/').pop();
      const parentId = parent ? pathToFolderId[parent] : folder.id;
      if (!parentId) {
        uploaded.errors.push(`Parent folder not found for "${fp}"`);
        continue;
      }
      const { data: existingFolder } = await supabase
        .from('folders')
        .select('id')
        .eq('parent_folder_id', parentId)
        .eq('name', name)
        .maybeSingle();
      if (existingFolder) {
        pathToFolderId[fp] = existingFolder.id;
        continue;
      }
      const { data: newFolder, error: fErr } = await supabase
        .from('folders')
        .insert({ parent_folder_id: parentId, name, entity_type: entityType, entity_id: entityId, created_by_user_id: userId })
        .select('id')
        .single();
      if (fErr) {
        uploaded.errors.push(`Folder "${fp}": ${fErr.message}`);
        continue;
      }
      pathToFolderId[fp] = newFolder.id;
      uploaded.folders++;
    }

    // Upload files
    for (const e of entries) {
      const parentPath = e.parts.slice(0, -1).join('/');
      const targetFolderId = parentPath ? pathToFolderId[parentPath] : folder.id;
      if (!targetFolderId) {
        uploaded.errors.push(`Target folder not found for "${e.relPath}"`);
        continue;
      }
      const fileData = await e.zipEntry.async('nodebuffer');
      const ext = path.extname(e.relPath) || '';
      const key = `${entityType}/${entityId}/${crypto.randomUUID()}${ext}`;
      const contentType = mime.lookup(e.relPath) || 'application/octet-stream';
      try {
        await storage.uploadBuffer('entity-files', key, fileData, contentType);
        const { error: fiErr } = await supabase.from('files').insert({
          folder_id: targetFolderId,
          name: e.parts[e.parts.length - 1],
          original_filename: e.parts[e.parts.length - 1],
          storage_path: key,
          mime_type: contentType,
          size_bytes: fileData.length,
          uploaded_by_user_id: userId,
        });
        if (fiErr) { uploaded.errors.push(`File "${e.relPath}": ${fiErr.message}`); continue; }
        uploaded.files++;
      } catch (upErr) {
        uploaded.errors.push(`File "${e.relPath}": ${upErr.message}`);
      }
    }
  } catch (zipErr) {
    setFlash(req, 'error', 'Failed to process .zip file: ' + zipErr.message);
    return res.redirect('/files/folders/' + folder.id);
  }

  const summary = `📦 Uploaded ${uploaded.folders} folder(s) and ${uploaded.files} file(s).`;
  const errSummary = uploaded.errors.length ? ` ${uploaded.errors.length} error(s).` : '';
  setFlash(req, 'success', summary + errSummary);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'file', entityId: folder.id, action: 'zip_uploaded', before: null, after: { folders: uploaded.folders, files: uploaded.files, errors: uploaded.errors.length }, source: 'user', userId });
  } catch(e) { /* audit best effort */ }
  res.redirect('/files/folders/' + folder.id);
});

// POST /folders/:folderId/subfolder — create subfolder
router.post('/folders/:folderId/subfolder', requireAuth, requireManager, async (req, res) => {
  const { data: folder } = await checkedFileRouteRead(supabase.from('folders').select('*').eq('id', req.params.folderId).maybeSingle(), 'file subfolder parent read failed');
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const name = (req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Folder name required.'); return res.redirect('/files/folders/' + folder.id); }
  const { error: rErr } = await supabase.from('folders').insert({
    parent_folder_id: folder.id, name, entity_type: folder.entity_type,
    entity_id: folder.entity_id, created_by_user_id: req.session.userId || null,
  });
  if (rErr) throw rErr;
  setFlash(req, 'success', 'Folder "' + name + '" created.');
  res.redirect('/files/folders/' + folder.id);
});

// POST /folders/:folderId/rename — rename folder (admin+)
router.post('/folders/:folderId/rename', requireAuth, requireAdmin, async (req, res) => {
  const { data: folder } = await checkedFileRouteRead(supabase.from('folders').select('*').eq('id', req.params.folderId).maybeSingle(), 'file rename folder read failed');
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const name = (req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Folder name required.'); return res.redirect('/files/folders/' + folder.id); }
  const { error: renameErr } = await supabase.from('folders').update({ name }).eq('id', folder.id);
  if (renameErr) throw renameErr;
  setFlash(req, 'success', 'Folder renamed.');
  res.redirect('/files/folders/' + folder.id);
});

// POST /folders/:folderId/delete — delete folder (admin+, empty only)
router.post('/folders/:folderId/delete', requireAuth, requireAdmin, async (req, res) => {
  const { data: folder } = await checkedFileRouteRead(supabase.from('folders').select('*').eq('id', req.params.folderId).maybeSingle(), 'file delete folder read failed');
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const contents = await filesService.getFolderContents(folder.id);
  if (contents.subfolders.length > 0 || contents.files.length > 0) {
    setFlash(req, 'error', 'Cannot delete non-empty folder.');
    return res.redirect('/files/folders/' + folder.id);
  }
  const { error: deleteErr } = await supabase.from('folders').delete().eq('id', folder.id);
  if (deleteErr) throw deleteErr;
  setFlash(req, 'success', 'Folder deleted.');
  const parent = folder.parent_folder_id ? '/files/folders/' + folder.parent_folder_id : '/files';
  res.redirect(parent);
});

// POST /:id/delete — delete file (uploader or admin+)
router.post('/:id/delete', requireAuth, async (req, res) => {
  const { data: file } = await checkedFileRouteRead(supabase.from('files').select('*').eq('id', req.params.id).maybeSingle(), 'file delete read failed');
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const isAdmin = req.session.role === 'admin';
  const isUploader = file.uploaded_by_user_id === req.session.userId;
  if (!isAdmin && !isUploader) return res.status(403).json({ error: 'Permission denied.' });
  await storage.remove('entity-files', file.storage_path || file.name);
  const { error: fileDeleteErr } = await supabase.from('files').delete().eq('id', file.id);
  if (fileDeleteErr) throw fileDeleteErr;
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'file', entityId: file.id, action: 'deleted', before: { filename: file.original_filename }, after: null, source: 'user', userId: req.session.userId });
  } catch(e) { /* audit best effort */ }
  setFlash(req, 'success', 'File deleted.');
  res.redirect('/files/folders/' + file.folder_id);
});

// GET /:id/view — inline preview via signed URL
router.get('/:id/view', requireAuth, async (req, res) => {
  const { data: file } = await checkedFileRouteRead(supabase.from('files').select('*').eq('id', req.params.id).maybeSingle(), 'file view read failed');
  if (!file) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'File not found.' });
  try {
    const signedUrl = await storage.getSignedUrl('entity-files', file.storage_path || file.name, 3600);
    return res.redirect(signedUrl);
  } catch (e) {
    return res.status(500).render('error', { title: 'Storage error', code: 500, message: 'Failed to access file: ' + e.message });
  }
});

// GET /:entityType/:entityId — show root folder contents (GENERIC — MUST BE LAST)
router.get('/:entityType/:entityId', requireAuth, async (req, res) => {
  const entityType = normalizeEntityType(req.params.entityType);
  const entityId = parseInt(req.params.entityId, 10);
  const mappedType = entityType === 'project' ? 'work_order' : entityType === 'worker' ? 'user' : entityType;
  if (!workerCanAccessEntity(req, entityType, entityId)) return workerForbidden(res);

  let folder = await filesService.getRootFolder(mappedType, entityId);
  if (!folder) {
    const folderId = await filesService.ensureRootFolder(mappedType, entityId, req.session.userId);
    folder = folderId ? await filesService.getRootFolder(mappedType, entityId) : null;
  }
  if (!folder) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No files for this entity.' });
  }

  const contents = await filesService.getFolderContents(folder.id);

  // Get entity name for display
  let entityName = '';
  if (entityType === 'customer') {
    const { data: c } = await checkedFileRouteRead(supabase.from('customers').select('name').eq('id', entityId).maybeSingle(), 'file customer name read failed');
    entityName = c ? c.name : 'Customer #' + entityId;
  } else if (entityType === 'vendor') {
    const { data: v } = await checkedFileRouteRead(supabase.from('vendors').select('name').eq('id', entityId).maybeSingle(), 'file vendor name read failed');
    entityName = v ? v.name : 'Vendor #' + entityId;
  } else if (entityType === 'worker') {
    const { data: u } = await checkedFileRouteRead(supabase.from('users').select('name').eq('id', entityId).maybeSingle(), 'file worker name read failed');
    entityName = u ? u.name : 'Worker #' + entityId;
  } else if (entityType === 'project') {
    const { data: wo } = await checkedFileRouteRead(supabase.from('work_orders').select('display_number').eq('id', entityId).maybeSingle(), 'file work order name read failed');
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

module.exports = router;
