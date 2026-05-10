/**
 * Jobs CRUD.
 *
 * Routes (all gated by requireAuth in server.js):
 *   GET    /jobs                      list with search + status filter + pagination
 *   GET    /jobs/new[?customer_id=N]  new form (optional pre-selected customer)
 *   POST   /jobs                      create
 *   GET    /jobs/:id                  detail (estimates/WOs/invoices sections)
 *   GET    /jobs/:id/edit             edit form
 *   POST   /jobs/:id                  update
 *   POST   /jobs/:id/delete           delete (rejected if any estimates/WOs/invoices exist)
 *
 * Validation: title + customer_id required. customer_id must exist.
 * status must be in enum (defaulted from schema).
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['lead', 'estimating', 'scheduled', 'in_progress', 'complete', 'cancelled'];

// --- helpers (mirror the patched customers.js pattern) ---

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function trimOrNull(v) { return emptyToNull(v); }

function validateJob(body) {
  const errors = {};
  const title = emptyToNull(body.title);
  if (!title) errors.title = 'Title is required.';
  if (title && title.length > 200) errors.title = 'Title is too long (max 200).';

  const customerIdRaw = body.customer_id;
  const customerId = parseInt(customerIdRaw, 10);
  if (!customerId || Number.isNaN(customerId)) {
    errors.customer_id = 'Customer is required.';
  } else {
    const exists = db.get('SELECT id FROM customers WHERE id = ?', [customerId]);
    if (!exists) errors.customer_id = 'Customer not found.';
  }

  const status = emptyToNull(body.status) || 'lead';
  if (!VALID_STATUSES.includes(status)) {
    errors.status = 'Invalid status.';
  }

  return {
    errors,
    data: {
      customer_id: customerId || null,
      title,
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      description: emptyToNull(body.description),
      status,
    }
  };
}

function blankJob() {
  return {
    id: null, customer_id: null, title: '',
    address: '', city: '', state: '', zip: '',
    description: '', status: 'lead'
  };
}

// --- routes ---

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (q) {
    conds.push('(j.title LIKE ? OR j.address LIKE ? OR j.city LIKE ? OR c.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    conds.push('j.status = ?');
    params.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (db.get(
    `SELECT COUNT(*) AS n FROM jobs j JOIN customers c ON c.id = j.customer_id ${where}`,
    params
  ) || {}).n || 0;

  const jobs = db.all(
    `SELECT j.id, j.title, j.status, j.address, j.city, j.state, j.created_at,
            c.id AS customer_id, c.name AS customer_name
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     ${where}
     ORDER BY j.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  res.render('jobs/index', {
    title: 'Jobs',
    activeNav: 'jobs',
    jobs, q, status, page, totalPages, total,
    statuses: VALID_STATUSES
  });
});

router.get('/new', (req, res) => {
  const customers = db.all('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE ASC');
  if (customers.length === 0) {
    setFlash(req, 'error', 'You need a customer before you can create a job.');
    return res.redirect('/customers/new');
  }
  const job = blankJob();
  const presetCustomer = parseInt(req.query.customer_id, 10);
  if (presetCustomer && customers.some(c => c.id === presetCustomer)) {
    job.customer_id = presetCustomer;
  }
  res.render('jobs/new', {
    title: 'New job',
    activeNav: 'jobs',
    job, customers, errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/', (req, res) => {
  const customers = db.all('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE ASC');
  const { errors, data } = validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/new', {
      title: 'New job',
      activeNav: 'jobs',
      job: { id: null, ...data },
      customers, errors, statuses: VALID_STATUSES
    });
  }
  const r = db.run(
    `INSERT INTO jobs (customer_id, title, address, city, state, zip, description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.customer_id, data.title, data.address, data.city, data.state, data.zip, data.description, data.status]
  );
  setFlash(req, 'success', `Job "${data.title}" created.`);
  res.redirect(`/jobs/${r.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const job = db.get(
    `SELECT j.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     WHERE j.id = ?`,
    [req.params.id]
  );
  if (!job) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  }

  // Related records (Phase 3+ will populate these tables)
  const estimates = db.all(
    `SELECT id, estimate_number, status, total, valid_until, created_at
     FROM estimates WHERE job_id = ? ORDER BY created_at DESC`,
    [req.params.id]
  );
  const workOrders = db.all(
    `SELECT id, wo_number, status, scheduled_date, completed_date, created_at
     FROM work_orders WHERE job_id = ? ORDER BY created_at DESC`,
    [req.params.id]
  );
  const invoices = db.all(
    `SELECT id, invoice_number, status, total, amount_paid, due_date, created_at
     FROM invoices WHERE job_id = ? ORDER BY created_at DESC`,
    [req.params.id]
  );

  res.render('jobs/show', {
    title: job.title,
    activeNav: 'jobs',
    job, estimates, workOrders, invoices
  });
});

router.get('/:id/edit', (req, res) => {
  const job = db.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  }
  const customers = db.all('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE ASC');
  res.render('jobs/edit', {
    title: `Edit ${job.title}`,
    activeNav: 'jobs',
    job, customers, errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/:id', (req, res) => {
  const job = db.get('SELECT id, title FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  }
  const customers = db.all('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE ASC');
  const { errors, data } = validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/edit', {
      title: `Edit ${job.title}`,
      activeNav: 'jobs',
      job: { id: job.id, ...data },
      customers, errors, statuses: VALID_STATUSES
    });
  }
  db.run(
    `UPDATE jobs
     SET customer_id=?, title=?, address=?, city=?, state=?, zip=?, description=?, status=?, updated_at=datetime('now')
     WHERE id=?`,
    [data.customer_id, data.title, data.address, data.city, data.state, data.zip, data.description, data.status, req.params.id]
  );
  setFlash(req, 'success', `Job "${data.title}" updated.`);
  res.redirect(`/jobs/${req.params.id}`);
});

router.post('/:id/delete', (req, res) => {
  const job = db.get('SELECT id, title FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  }
  const counts = {
    estimates: (db.get('SELECT COUNT(*) AS n FROM estimates WHERE job_id = ?', [req.params.id]) || {}).n || 0,
    workOrders: (db.get('SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?', [req.params.id]) || {}).n || 0,
    invoices: (db.get('SELECT COUNT(*) AS n FROM invoices WHERE job_id = ?', [req.params.id]) || {}).n || 0,
  };
  const blockers = [];
  if (counts.estimates) blockers.push(`${counts.estimates} estimate(s)`);
  if (counts.workOrders) blockers.push(`${counts.workOrders} work order(s)`);
  if (counts.invoices) blockers.push(`${counts.invoices} invoice(s)`);
  if (blockers.length) {
    setFlash(req, 'error',
      `Cannot delete "${job.title}" — it has ${blockers.join(', ')}. Remove those first.`);
    return res.redirect(`/jobs/${req.params.id}`);
  }
  db.run('DELETE FROM jobs WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', `Job "${job.title}" deleted.`);
  res.redirect('/jobs');
});

module.exports = router;
