/**
 * Work Orders CRUD (v0.5).
 *
 * WO is the ROOT document: customer -> job -> WO -> estimate -> invoice.
 *
 *   GET  /                       list
 *   GET  /new?job_id=N           new root WO form
 *   POST /                       create (with optional editable display number)
 *   GET  /:id                    show (sub-WOs, line items, related estimate/invoice)
 *   POST /:id/sub                create sub-WO under this WO
 *   GET  /:id/edit               edit (allowed when scheduled or in_progress)
 *   POST /:id                    update
 *   POST /:id/start              scheduled -> in_progress
 *   POST /:id/complete           in_progress -> complete (stamps completed_date)
 *   POST /:id/cancel             scheduled|in_progress -> cancelled
 *   GET  /:id/pdf                PDF (inline or ?download=1)
 *   POST /:id/delete             delete (FK guard against estimates)
 *
 * Display number is editable on creation. If user supplies a custom
 * display_number in "0001-0000" format we use it; otherwise we auto-
 * generate via numbering.nextRootWoNumber() (or nextSubWoNumber for subs).
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const calc = require('../services/calculations');
const numbering = require('../services/numbering');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Multer config — WO photo uploads
const UPLOAD_BASE = path.join(__dirname, '..', '..', 'public', 'uploads', 'wo');
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 6;
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
const woUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_BASE, String(req.params.id));
      ensureDir(dir); cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ts = Date.now();
      const s = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
      cb(null, `${ts}-${s}`);
    }
  }),
  limits: { fileSize: MAX_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only jpg/png/webp/heic allowed.'));
  }
});
const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['scheduled', 'in_progress', 'complete', 'cancelled'];
const VALID_UNITS = ['ea', 'hr', 'sqft', 'lf', 'ton', 'lot'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function asArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input !== 'object') return [];
  return Object.keys(input).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map(k => input[k]);
}

function validateLineItem(li) {
  const description = emptyToNull(li.description);
  const unit = emptyToNull(li.unit) || 'ea';
  const quantity = parseFloat(li.quantity);
  const unitPrice = parseFloat(li.unit_price);
  const cost = parseFloat(li.cost);
  const completed = (li.completed === '1' || li.completed === 'on' || li.completed === true || li.completed === 1) ? 1 : 0;
  return {
    data: {
      description,
      quantity: isFinite(quantity) && quantity >= 0 ? quantity : 0,
      unit: VALID_UNITS.includes(unit) ? unit : 'ea',
      unit_price: isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      cost: isFinite(cost) && cost >= 0 ? cost : 0,
      completed,
    }
  };
}

function validateWorkOrder(body) {
  const errors = {};
  const scheduledDate = emptyToNull(body.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) errors.scheduled_date = 'Use YYYY-MM-DD.';
  const scheduledTime = emptyToNull(body.scheduled_time);
  if (scheduledTime && !/^\d{2}:\d{2}$/.test(scheduledTime)) errors.scheduled_time = 'Use HH:MM.';
  const assignedUserId = body.assigned_to_user_id ? parseInt(body.assigned_to_user_id, 10) : null;
  const assignedToText = emptyToNull(body.assigned_to);

  // Optional editable display number override
  let mainOverride = null, subOverride = null;
  const numOverride = emptyToNull(body.display_number);
  if (numOverride) {
    const parsed = numbering.parseDisplay(numOverride);
    if (!parsed) errors.display_number = 'Use format 0001-0000';
    else {
      mainOverride = parsed.main;
      subOverride = parsed.sub;
    }
  }

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    if (!emptyToNull(li.description)) return;
    items.push(validateLineItem(li).data);
  });

  return {
    errors,
    data: {
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      assigned_to_user_id: assignedUserId,
      assigned_to: assignedToText,
      notes: emptyToNull(body.notes),
      display_number_override: numOverride ? { main: mainOverride, sub: subOverride } : null,
      lines: items,
    }
  };
}

function loadWorkOrder(id) {
  const wo = db.get(
    `SELECT w.*,
            j.title   AS job_title,
            j.address AS job_address,
            j.city    AS job_city,
            j.state   AS job_state,
            j.zip     AS job_zip,
            c.id      AS customer_id,
            c.name    AS customer_name,
            c.email   AS customer_email,
            c.billing_email AS customer_billing_email,
            c.phone   AS customer_phone,
            c.address AS customer_address,
            c.city    AS customer_city,
            c.state   AS customer_state,
            c.zip     AS customer_zip,
            u.name    AS assigned_user_name,
            parent.display_number AS parent_display_number
     FROM work_orders w
     JOIN jobs j      ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN users u ON u.id = w.assigned_to_user_id
     LEFT JOIN work_orders parent ON parent.id = w.parent_wo_id
     WHERE w.id = ?`,
    [id]
  );
  if (!wo) return null;
  wo.lines = db.all(
    `SELECT * FROM work_order_line_items WHERE work_order_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  return wo;
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (q) {
    conds.push('(w.display_number LIKE ? OR j.title LIKE ? OR c.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    conds.push('w.status = ?');
    params.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (db.get(
    `SELECT COUNT(*) AS n FROM work_orders w
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id ${where}`,
    params
  ) || {}).n || 0;

  const workOrders = db.all(
    `SELECT w.id, w.display_number, w.wo_number_main, w.wo_number_sub, w.parent_wo_id,
            w.status, w.scheduled_date, w.completed_date, w.created_at,
            j.id AS job_id, j.title AS job_title,
            c.id AS customer_id, c.name AS customer_name,
            u.name AS assigned_name
     FROM work_orders w
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN users u ON u.id = w.assigned_to_user_id
     ${where}
     ORDER BY w.wo_number_main DESC, w.wo_number_sub ASC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('work-orders/index', {
    title: 'Work Orders', activeNav: 'work-orders',
    workOrders, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/new', (req, res) => {
  const jobId = parseInt(req.query.job_id, 10);
  if (!jobId) {
    setFlash(req, 'error', 'Pick a job first to create a work order from.');
    return res.redirect('/jobs');
  }
  const job = db.get(
    `SELECT j.*, c.id AS customer_id, c.name AS customer_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`,
    [jobId]
  );
  if (!job) {
    setFlash(req, 'error', 'Job not found.');
    return res.redirect('/jobs');
  }

  // Suggest the next root WO number (purely for display in the form)
  const settings = db.get('SELECT next_wo_main_number FROM company_settings WHERE id = 1');
  const suggestedDisplay = numbering.formatDisplay(settings ? settings.next_wo_main_number : 1, 0);

  const wo = {
    id: null, job_id: jobId, parent_wo_id: null,
    display_number: '', // user can override; blank means auto
    suggested_display_number: suggestedDisplay,
    status: 'scheduled',
    scheduled_date: '', scheduled_time: '',
    assigned_to_user_id: null, assigned_to: '',
    notes: '', lines: [],
  };
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  res.render('work-orders/new', {
    title: 'New work order', activeNav: 'work-orders',
    wo, job, users, errors: {}, units: VALID_UNITS, isSubWO: false
  });
});

router.post('/', (req, res) => {
  const jobId = parseInt(req.body.job_id, 10);
  const job = jobId ? db.get(
    `SELECT j.*, c.id AS customer_id, c.name AS customer_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`,
    [jobId]
  ) : null;

  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  const { errors, data } = validateWorkOrder(req.body);
  if (!job) errors.job_id = 'Job is required.';

  if (Object.keys(errors).length) {
    return res.status(400).render('work-orders/new', {
      title: 'New work order', activeNav: 'work-orders',
      wo: { id: null, job_id: jobId, parent_wo_id: null, ...data,
            display_number: req.body.display_number || '' },
      job: job || { id: jobId }, users, errors,
      units: VALID_UNITS, isSubWO: false
    });
  }

  // Resolve numbering
  let main, sub, display;
  if (data.display_number_override) {
    ({ main, sub } = data.display_number_override);
    display = numbering.formatDisplay(main, sub);
    // Reject if already taken
    const dup = db.get('SELECT id FROM work_orders WHERE display_number = ?', [display]);
    if (dup) {
      errors.display_number = `WO ${display} already exists.`;
      return res.status(400).render('work-orders/new', {
        title: 'New work order', activeNav: 'work-orders',
        wo: { id: null, job_id: jobId, parent_wo_id: null, ...data,
              display_number: req.body.display_number || '' },
        job, users, errors, units: VALID_UNITS, isSubWO: false
      });
    }
  } else {
    const next = numbering.nextRootWoNumber();
    main = next.main; sub = next.sub; display = next.display;
  }

  const newId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO work_orders
       (job_id, parent_wo_id, wo_number_main, wo_number_sub, display_number, status,
        scheduled_date, scheduled_time, assigned_to_user_id, assigned_to, notes)
       VALUES (?, NULL, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
      [job.id, main, sub, display, data.scheduled_date, data.scheduled_time,
       data.assigned_to_user_id, data.assigned_to, data.notes]
    );
    const woId = r.lastInsertRowid;
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO work_order_line_items
         (work_order_id, description, quantity, unit, unit_price, cost, line_total, completed, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [woId, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, li.completed, idx]
      );
    });
    return woId;
  });

  setFlash(req, 'success', `Work order WO-${display} created.`);
  res.redirect(`/work-orders/${newId}`);
});

// ---- AI-assisted WO creation (Round 8) ----
// These MUST come before /:id routes to avoid Express route collision with /ai-create being caught as :id

router.get('/ai-create', (req, res) => {
  res.render('work-orders/ai-create', { title: 'AI-assisted work order', activeNav: 'work-orders', text: '', error: null });
});

router.post('/ai-create', async (req, res) => {
  const text = (req.body.description || '').trim();
  if (!text || text.length < 20) {
    return res.render('work-orders/ai-create', { title: 'AI-assisted WO', activeNav: 'work-orders', text, error: 'Provide more detail (at least 20 characters).' });
  }
  const ai = require('../services/ai');
  if (!ai.isConfigured()) {
    return res.render('work-orders/ai-create', { title: 'AI-assisted WO', activeNav: 'work-orders', text, error: 'AI not configured. Add AI_API_KEY to .env.' });
  }
  const customers = db.all('SELECT id, name, email FROM customers');
  const users = db.all("SELECT id, name FROM users WHERE active = 1");
  try {
    const result = await ai.extractWorkOrder({ text, customers, users, userId: req.session.userId });
    if (!result.ok) {
      return res.render('work-orders/ai-create', { title: 'AI-assisted WO', activeNav: 'work-orders', text, error: `AI parse failed: ${result.reason}` });
    }
    res.render('work-orders/ai-create-preview', {
      title: 'Review AI extraction',
      activeNav: 'work-orders',
      extracted: result.data,
      rawText: text,
      customers, users,
      tokens: result.tokens,
    });
  } catch (err) {
    console.error('AI extraction error:', err);
    res.render('work-orders/ai-create', { title: 'AI-assisted WO', activeNav: 'work-orders', text, error: `AI error: ${err.message}` });
  }
});

router.post('/ai-finalize', (req, res) => {
  const { customer_action, customer_name, customer_email, customer_id } = req.body;
  const jobTitle = (req.body.job_title || '').trim();
  const jobAddress = (req.body.job_address || '').trim();
  const jobCity = (req.body.job_city || '').trim();
  const jobState = (req.body.job_state || '').trim();
  const jobZip = (req.body.job_zip || '').trim();
  const jobDescription = (req.body.job_description || '').trim();
  const scheduledDate = (req.body.scheduled_date || '').trim() || null;
  const scheduledTime = (req.body.scheduled_time || '').trim() || null;
  const notes = (req.body.notes || '').trim() || null;

  if (!jobTitle) {
    setFlash(req, 'error', 'Job title is required.');
    return res.redirect('/work-orders/ai-create');
  }

  // Resolve customer
  let resolvedCustomerId;
  if (customer_action === 'use_existing' && customer_id) {
    resolvedCustomerId = parseInt(customer_id, 10);
  } else {
    const name = (customer_name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Customer name is required for a new customer.');
      return res.redirect('/work-orders/ai-create');
    }
    resolvedCustomerId = db.run(
      `INSERT INTO customers (name, email, created_at) VALUES (?, ?, datetime('now'))`,
      [name, customer_email || null]
    ).lastInsertRowid;
  }

  // Create job
  const jobId = db.run(
    `INSERT INTO jobs (customer_id, title, address, city, state, zip, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'estimating', datetime('now'))`,
    [resolvedCustomerId, jobTitle, jobAddress, jobCity, jobState, jobZip, jobDescription]
  ).lastInsertRowid;

  // Create work order
  const calc = require('../services/calculations');
  const numbering = require('../services/numbering');
  const next = numbering.nextRootWoNumber();
  const display = next.display;

  // Parse assignees from req.body.assignees (array of {name, user_id})
  const rawAssignees = (() => {
    const input = req.body.assignees;
    if (!input) return [];
    if (Array.isArray(input)) return input;
    return Object.keys(input).sort((a, b) => parseInt(a,10)-parseInt(b,10)).map(k => input[k]);
  })();
  // For the first assignee with a user_id, they become assigned_to_user_id
  // The rest are concatenated into assigned_to text
  let assignedUserId = null;
  let assignedToParts = [];
  rawAssignees.forEach(a => {
    const uid = a.user_id ? parseInt(a.user_id, 10) : null;
    if (uid && !assignedUserId) assignedUserId = uid;
    else assignedToParts.push(a.name);
  });
  // Also include the named user who's the primary assignee
  if (assignedUserId) {
    const u = db.get('SELECT name FROM users WHERE id = ?', [assignedUserId]);
    if (u) assignedToParts.unshift(u.name);
  }
  const assignedToText = assignedToParts.filter(Boolean).join(', ') || null;

  const woId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO work_orders
       (job_id, parent_wo_id, wo_number_main, wo_number_sub, display_number, status,
        scheduled_date, scheduled_time, assigned_to_user_id, assigned_to, notes, created_at)
       VALUES (?, NULL, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, datetime('now'))`,
      [jobId, next.main, next.sub, display, scheduledDate, scheduledTime, assignedUserId, assignedToText, notes]
    );
    const wid = r.lastInsertRowid;

    // Insert line items
    const rawLines = (() => {
      const input = req.body.lines;
      if (!input) return [];
      if (Array.isArray(input)) return input;
      return Object.keys(input).sort((a,b)=>parseInt(a,10)-parseInt(b,10)).map(k => input[k]);
    })();
    rawLines.forEach((li, idx) => {
      const desc = (li.description || '').trim();
      if (!desc) return;
      const qty = parseFloat(li.quantity) || 0;
      const up = parseFloat(li.unit_price) || 0;
      const lt = Math.round(qty * up * 100) / 100;
      db.run(
        `INSERT INTO work_order_line_items
         (work_order_id, description, quantity, unit, unit_price, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wid, desc, qty, li.unit || 'ea', up, lt, idx]
      );
    });
    return wid;
  });

  setFlash(req, 'success', `WO-${display} created from AI extraction.`);
  res.redirect(`/work-orders/${woId}`);
});

// Sub-WO creation (POST /:id/sub) — opens a new form scoped to this parent
router.get('/:id/sub/new', (req, res) => {
  const parent = loadWorkOrder(req.params.id);
  if (!parent) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Parent WO not found.' });
  const job = db.get('SELECT id, title FROM jobs WHERE id = ?', [parent.job_id]);

  const next = numbering.nextSubWoNumber(parent.id);
  const wo = {
    id: null, job_id: parent.job_id, parent_wo_id: parent.id,
    display_number: '', suggested_display_number: next.display,
    status: 'scheduled',
    scheduled_date: '', scheduled_time: '',
    assigned_to_user_id: null, assigned_to: '', notes: '', lines: []
  };
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  res.render('work-orders/new', {
    title: `Sub-WO under ${parent.display_number}`, activeNav: 'work-orders',
    wo, job, users, errors: {}, units: VALID_UNITS, isSubWO: true, parent
  });
});

router.post('/:id/sub', (req, res) => {
  const parent = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!parent) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Parent WO not found.' });

  const { errors, data } = validateWorkOrder(req.body);
  let main, sub, display;
  if (data.display_number_override) {
    ({ main, sub } = data.display_number_override);
    if (main !== parent.wo_number_main) {
      errors.display_number = `Sub-WO must use main ${numbering.pad(parent.wo_number_main, 4)} (parent's).`;
    } else {
      display = numbering.formatDisplay(main, sub);
      const dup = db.get('SELECT id FROM work_orders WHERE display_number = ?', [display]);
      if (dup) errors.display_number = `WO ${display} already exists.`;
    }
  } else {
    const next = numbering.nextSubWoNumber(parent.id);
    main = next.main; sub = next.sub; display = next.display;
  }

  if (Object.keys(errors).length) {
    const job = db.get('SELECT id, title FROM jobs WHERE id = ?', [parent.job_id]);
    const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
    return res.status(400).render('work-orders/new', {
      title: `Sub-WO under ${parent.display_number}`, activeNav: 'work-orders',
      wo: { id: null, job_id: parent.job_id, parent_wo_id: parent.id, ...data,
            display_number: req.body.display_number || '' },
      job, users, errors, units: VALID_UNITS, isSubWO: true, parent
    });
  }

  const newId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO work_orders
       (job_id, parent_wo_id, wo_number_main, wo_number_sub, display_number, status,
        scheduled_date, scheduled_time, assigned_to_user_id, assigned_to, notes)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
      [parent.job_id, parent.id, main, sub, display, data.scheduled_date, data.scheduled_time,
       data.assigned_to_user_id, data.assigned_to, data.notes]
    );
    const woId = r.lastInsertRowid;
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO work_order_line_items
         (work_order_id, description, quantity, unit, unit_price, cost, line_total, completed, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [woId, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, li.completed, idx]
      );
    });
    return woId;
  });

  setFlash(req, 'success', `Sub-WO WO-${display} created.`);
  res.redirect(`/work-orders/${newId}`);
});

router.get('/:id', (req, res) => {
  const wo = loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });

  const subs = db.all(
    `SELECT id, display_number, wo_number_sub, status, scheduled_date, completed_date, created_at
     FROM work_orders WHERE parent_wo_id = ? ORDER BY wo_number_sub ASC`,
    [wo.id]
  );
  const estimate = db.get('SELECT id, status FROM estimates WHERE work_order_id = ?', [wo.id]);
  const invoice = estimate ? db.get('SELECT id, status FROM invoices WHERE estimate_id = ?', [estimate.id]) : null;

  // Notes feed (newest last so it reads top-down chronologically)
  let notes = [];
  try {
    notes = db.all(
      `SELECT n.id, n.body, n.created_at, u.name AS user_name
       FROM wo_notes n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.work_order_id = ?
       ORDER BY n.created_at ASC`,
      [wo.id]
    );
  } catch (e) {
    // wo_notes table may be missing on very old DBs
  }

  // Fetch photos
  let photos = [];
  try {
    photos = db.all(
      `SELECT p.*, u.name AS user_name
       FROM wo_photos p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.work_order_id = ?
       ORDER BY p.created_at DESC`,
      [wo.id]
    );
  } catch (e) {}

  res.render('work-orders/show', {
    title: `WO-${wo.display_number}`, activeNav: 'work-orders',
    wo, subs, estimate, invoice, notes, photos
  });
});

router.get('/:id/edit', (req, res) => {
  const wo = loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (['complete', 'cancelled'].includes(wo.status)) {
    setFlash(req, 'error', `WO-${wo.display_number} is "${wo.status}" and cannot be edited.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  res.render('work-orders/edit', {
    title: `Edit WO-${wo.display_number}`, activeNav: 'work-orders',
    wo, users, errors: {}, units: VALID_UNITS
  });
});

router.post('/:id', (req, res) => {
  const existing = loadWorkOrder(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (['complete', 'cancelled'].includes(existing.status)) {
    setFlash(req, 'error', `WO-${existing.display_number} is "${existing.status}" and cannot be edited.`);
    return res.redirect(`/work-orders/${existing.id}`);
  }

  const { errors, data } = validateWorkOrder(req.body);
  // For edit, allow display number override if it's unique and matches parent constraint
  let newDisplay = existing.display_number;
  let newMain = existing.wo_number_main, newSub = existing.wo_number_sub;
  if (data.display_number_override) {
    const { main, sub } = data.display_number_override;
    if (existing.parent_wo_id && main !== existing.wo_number_main) {
      errors.display_number = 'Sub-WO main must match parent.';
    } else {
      const candidate = numbering.formatDisplay(main, sub);
      if (candidate !== existing.display_number) {
        const dup = db.get('SELECT id FROM work_orders WHERE display_number = ? AND id != ?', [candidate, existing.id]);
        if (dup) errors.display_number = `WO ${candidate} already exists.`;
        else { newDisplay = candidate; newMain = main; newSub = sub; }
      }
    }
  }

  if (Object.keys(errors).length) {
    const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
    return res.status(400).render('work-orders/edit', {
      title: `Edit WO-${existing.display_number}`, activeNav: 'work-orders',
      wo: { ...existing, ...data, display_number: req.body.display_number || existing.display_number },
      users, errors, units: VALID_UNITS
    });
  }

  // ── Item-completion audit: snapshot old completed states ──
  const oldLines = db.all('SELECT id, description, completed, completed_at FROM work_order_line_items WHERE work_order_id = ?', [existing.id]);

  db.transaction(() => {
    db.run(
      `UPDATE work_orders SET
         wo_number_main=?, wo_number_sub=?, display_number=?,
         scheduled_date=?, scheduled_time=?, assigned_to_user_id=?, assigned_to=?, notes=?,
         updated_at=datetime('now')
       WHERE id=?`,
      [newMain, newSub, newDisplay,
       data.scheduled_date, data.scheduled_time, data.assigned_to_user_id, data.assigned_to, data.notes,
       existing.id]
    );
    db.run('DELETE FROM work_order_line_items WHERE work_order_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      const isCompleted = li.completed ? 1 : 0;
      // Check if this line was previously NOT completed (new completion)
      const oldLine = oldLines[idx] || oldLines.find(o => String(o.description).trim() === String(li.description || '').trim());
      const wasAlreadyCompleted = oldLine && oldLine.completed === 1 && oldLine.completed_at;
      const completedAt = isCompleted && !wasAlreadyCompleted ? "datetime('now')" : (oldLine && oldLine.completed_at ? `'${oldLine.completed_at}'` : 'NULL');
      db.run(
        `INSERT INTO work_order_line_items
         (work_order_id, description, quantity, unit, unit_price, cost, line_total, completed, completed_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${completedAt}, ?)`,
        [existing.id, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, isCompleted, idx]
      );
      // Write audit for new completions
      if (isCompleted && !wasAlreadyCompleted) {
        try {
          const { writeAudit } = require('../services/audit');
          writeAudit({
            entityType: 'work_order_line_item', entityId: 0,
            action: 'item_completed',
            before: {}, after: { wo_id: existing.id, description: li.description, quantity: li.quantity, unit: li.unit },
            source: 'user', userId: req.session.userId
          });
        } catch(e) { console.error('item-completion audit failed:', e.message); }
      }
    });
  });

  setFlash(req, 'success', `WO-${newDisplay} updated.`);
  res.redirect(`/work-orders/${existing.id}`);
});

// Note: item-completion audit hook requires per-line diff tracking,
// which is incompatible with the delete-then-insert pattern above.
// TODO Round 16+: use a before/after snapshot for audit.

function statusTransition(req, res, fromStatus, toStatus, timestampField) {
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(wo.status)) {
    setFlash(req, 'error', `Cannot move WO-${wo.display_number} from "${wo.status}" to "${toStatus}".`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const params = [toStatus];
  if (timestampField) sets.push(`${timestampField} = datetime('now')`);
  db.run(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = ?`, [...params, wo.id]);
  // Audit log
  try {
    const { writeAudit } = require('../services/audit');
    const auditAction = toStatus === 'in_progress' ? 'started' : toStatus;
    writeAudit({ entityType: 'work_order', entityId: wo.id, action: auditAction, before: { status: wo.status }, after: { status: toStatus }, source: 'web', userId: req.session.userId });
  } catch(e) { console.error('audit failed:', e.message); }
  setFlash(req, 'success', `WO-${wo.display_number} marked ${toStatus.replace('_',' ')}.`);
  res.redirect(`/work-orders/${wo.id}`);
}

router.post('/:id/start',    (req, res) => statusTransition(req, res, 'scheduled', 'in_progress', null));
router.post('/:id/complete', (req, res) => statusTransition(req, res, 'in_progress', 'complete', 'completed_date'));
router.post('/:id/cancel',   (req, res) => statusTransition(req, res, ['scheduled','in_progress'], 'cancelled', null));

// POST /:id/notes — add a note to a work order
router.post('/:id/notes', (req, res) => {
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) {
    setFlash(req, 'error', 'Work order not found.');
    return res.redirect('/work-orders');
  }
  // Permission: workers can post only on assigned WOs
  if (req.session.role === 'worker') {
    const isAssigned = wo.assigned_to_user_id === req.session.userId ||
      (wo.assigned_to && wo.assigned_to.includes(req.session.userName || ''));
    if (!isAssigned) {
      setFlash(req, 'error', 'You can only post notes on work orders assigned to you.');
      return res.redirect(`/work-orders/${wo.id}`);
    }
  }
  const body = (req.body.body || '').trim();
  if (!body || body.length < 2) {
    setFlash(req, 'error', 'Note must be at least 2 characters.');
    return res.redirect(`/work-orders/${wo.id}`);
  }
  db.run(`INSERT INTO wo_notes (work_order_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [wo.id, req.session.userId, body]);
  setFlash(req, 'success', 'Note posted.');
  res.redirect(`/work-orders/${wo.id}`);
});

// POST /:id/photos — upload photos
router.post('/:id/photos', (req, res) => {
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) { setFlash(req, 'error', 'Work order not found.'); return res.redirect('/work-orders'); }
  if (req.session.role === 'worker') {
    const isAssigned = wo.assigned_to_user_id === req.session.userId ||
      (wo.assigned_to && wo.assigned_to.includes(req.session.userName || ''));
    if (!isAssigned) { setFlash(req, 'error', 'You can only upload photos to assigned WOs.'); return res.redirect(`/work-orders/${wo.id}`); }
  }
  woUpload.array('photos', MAX_FILES)(req, res, (err) => {
    if (err) { setFlash(req, 'error', err.message); return res.redirect(`/work-orders/${wo.id}`); }
    const files = req.files || [];
    if (files.length === 0) { setFlash(req, 'error', 'No files selected.'); return res.redirect(`/work-orders/${wo.id}`); }
    const caption = (req.body.caption || '').trim();
    db.transaction(() => {
      files.forEach(f => {
        db.run(`INSERT INTO wo_photos (work_order_id, user_id, filename, caption, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
          [wo.id, req.session.userId, f.filename, caption || null]);
      });
      // Single audit row for the batch
      writeAudit({ entityType: 'work_order', entityId: wo.id, action: 'photo_uploaded', before: {}, after: { count: files.length, filenames: files.map(f => f.filename) }, source: 'user', userId: req.session.userId });
    });
    const msg = files.length === 1 ? '1 photo uploaded.' : `${files.length} photos uploaded.`;
    setFlash(req, 'success', msg);
    res.redirect(`/work-orders/${wo.id}`);
  });
});

// POST /:id/photos/:photoId/delete — delete a photo
router.post('/:id/photos/:photoId/delete', (req, res) => {
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) { setFlash(req, 'error', 'Work order not found.'); return res.redirect('/work-orders'); }
  const photo = db.get('SELECT * FROM wo_photos WHERE id = ? AND work_order_id = ?', [req.params.photoId, wo.id]);
  if (!photo) { setFlash(req, 'error', 'Photo not found.'); return res.redirect(`/work-orders/${wo.id}`); }
  // Permission: uploader or manager+
  const isOwner = photo.user_id === req.session.userId;
  const isManager = req.session.role !== 'worker';
  if (!isOwner && !isManager) { setFlash(req, 'error', 'You can only delete your own photos.'); return res.redirect(`/work-orders/${wo.id}`); }
  // Delete file from disk
  const filepath = path.join(UPLOAD_BASE, String(wo.id), photo.filename);
  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch(e) { /* best effort */ }
  db.run('DELETE FROM wo_photos WHERE id = ?', [photo.id]);
  setFlash(req, 'success', 'Photo deleted.');
  res.redirect(`/work-orders/${wo.id}`);
});

router.get('/:id/pdf', (req, res) => {
  const wo = loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  const filename = `WO-${wo.display_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    pdf.generateWorkOrderPDF({ ...wo, wo_number: `WO-${wo.display_number}` }, company, res);
  } catch (err) {
    console.error('WO PDF failed:', err);
    if (!res.headersSent) res.status(500).render('error', { title: 'PDF error', code: 500, message: err.message });
    else res.end();
  }
});

router.post('/:id/delete', (req, res) => {
  const wo = db.get('SELECT id, display_number FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  const subCount = (db.get('SELECT COUNT(*) AS n FROM work_orders WHERE parent_wo_id = ?', [wo.id]) || {}).n || 0;
  if (subCount) {
    setFlash(req, 'error', `Cannot delete WO-${wo.display_number} — ${subCount} sub-WO(s) attached.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  const estCount = (db.get('SELECT COUNT(*) AS n FROM estimates WHERE work_order_id = ?', [wo.id]) || {}).n || 0;
  if (estCount) {
    setFlash(req, 'error', `Cannot delete WO-${wo.display_number} — an estimate references it.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  db.run('DELETE FROM work_order_line_items WHERE work_order_id = ?', [wo.id]);
  db.run('DELETE FROM work_orders WHERE id = ?', [wo.id]);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'work_order', entityId: wo.id, action: 'deleted', before: null, after: null, source: 'web', userId: req.session.userId });
  } catch(e) {}
  setFlash(req, 'success', `WO-${wo.display_number} deleted.`);
  res.redirect('/work-orders');
});

// Create estimate from this WO (1:1)
router.post('/:id/create-estimate', (req, res) => {
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  const existing = db.get('SELECT id FROM estimates WHERE work_order_id = ?', [wo.id]);
  if (existing) {
    setFlash(req, 'info', `Estimate already exists for WO-${wo.display_number}.`);
    return res.redirect(`/estimates/${existing.id}`);
  }

  const lines = db.all(
    `SELECT * FROM work_order_line_items WHERE work_order_id = ? ORDER BY sort_order ASC, id ASC`,
    [wo.id]
  );
  const settings = db.get('SELECT default_tax_rate FROM company_settings WHERE id = 1') || { default_tax_rate: 0 };
  const taxRate = Number(settings.default_tax_rate) || 0;
  const totals = calc.totals(lines, taxRate);
  const costTotal = lines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);

  const newId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO estimates (work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total)
       VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
      [wo.id, totals.subtotal, taxRate, totals.taxAmount, totals.total, costTotal]
    );
    const eid = r.lastInsertRowid;
    lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO estimate_line_items (estimate_id, description, quantity, unit, unit_price, cost, line_total, selected, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [eid, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, idx]
      );
    });
    return eid;
  });

  setFlash(req, 'success', `Estimate EST-${wo.display_number} created from WO-${wo.display_number}.`);
  res.redirect(`/estimates/${newId}`);
});

module.exports = router;
