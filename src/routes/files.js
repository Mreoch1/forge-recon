/**
 * files.js — File system browse routes.
 * Mounted at /files under requireAuth.
 * Admin+Manager full access; Workers see only own.
 */
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { requireAuth, requireAdmin, setFlash } = require('../middleware/auth');
const filesService = require('../services/files');

const ENTITY_TYPES = [
  { key: 'customer', label: 'Customers', icon: '🏢', path: '/files/customers' },
  { key: 'vendor', label: 'Vendors', icon: '📦', path: '/files/vendors' },
  { key: 'worker', label: 'Workers', icon: '👤', path: '/files/workers' },
  { key: 'project', label: 'Projects', icon: '🔧', path: '/files/projects' },
  { key: 'global', label: 'Global', icon: '🌐', path: '/files/global' },
];

// GET /files — index showing 5 buckets
router.get('/', requireAuth, (req, res) => {
  res.render('files/index', {
    title: 'Files',
    activeNav: 'files',
    buckets: ENTITY_TYPES,
  });
});

// GET /files/:entityType — list entities of that type with root folders
router.get('/:entityType', requireAuth, (req, res) => {
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
router.get('/:entityType/:entityId', requireAuth, (req, res) => {
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
    const c = db.get('SELECT name FROM customers WHERE id = ?', [entityId]);
    entityName = c ? c.name : 'Customer #' + entityId;
  } else if (entityType === 'vendor') {
    const v = db.get('SELECT name FROM vendors WHERE id = ?', [entityId]);
    entityName = v ? v.name : 'Vendor #' + entityId;
  } else if (entityType === 'worker') {
    const u = db.get('SELECT name FROM users WHERE id = ?', [entityId]);
    entityName = u ? u.name : 'Worker #' + entityId;
  } else if (entityType === 'project') {
    const wo = db.get('SELECT display_number FROM work_orders WHERE id = ?', [entityId]);
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
router.get('/folders/:folderId', requireAuth, (req, res) => {
  const folder = db.get('SELECT * FROM folders WHERE id = ?', [req.params.folderId]);
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

module.exports = router;
