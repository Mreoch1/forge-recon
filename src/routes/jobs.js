/**
 * Jobs CRUD (v0.5).
 *
 * Adds: scheduled_date, scheduled_time, assigned_to_user_id.
 * GET /new: if ?customer_id=N is present, auto-prefills the site address
 * fields with the customer's address (overridable in the form).
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();
const PAGE_SIZE = 25;
const VALID_STATUSES = ['lead', 'estimating', 'scheduled', 'in_progress', 'complete', 'cancelled'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validateJob(body) {
  const errors = {};
  const title = emptyToNull(body.title);
  if (!title) errors.title = 'Title is required.';
  if (title && title.length > 200) errors.title = 'Too long (max 200).';

  const customerId = parseInt(body.customer_id, 10);
  if (!customerId) errors.customer_id = 'Customer is required.';
  else if (!db.get('SELECT id FROM customers WHERE id = ?', [customerId])) {
    errors.customer_id = 'Customer not found.';
  }

  const status = emptyToNull(body.status) || 'lead';
  if (!VALID_STATUSES.includes(status)) errors.status = 'Invalid status.';

  const scheduledDate = emptyToNull(body.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    errors.scheduled_date = 'Use YYYY-MM-DD.';
  }
  const scheduledTime = emptyToNull(body.scheduled_time);
  if (scheduledTime && !/^\d{2}:\d{2}$/.test(scheduledTime)) {
    errors.scheduled_time = 'Use HH:MM.';
  }

  const assignedUserId = body.assigned_to_user_id ? parseInt(body.assigned_to_user_id, 10) : null;
  if (assignedUserId) {
    const u = db.get('SELECT id FROM users WHERE id = ? AND active = 1', [assignedUserId]);
    if (!u) errors.assigned_to_user_id = 'User not found or inactive.';
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
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      assigned_to_user_id: assignedUserId,
    }
  };
}

function blankJob() {
  return {
    id: null, customer_id: null, title: '',
    address: '', city: '', state: '', zip: '',
    description: '', status: 'lead',
    scheduled_date: '', scheduled_time: '', assigned_to_user_id: null,
  };
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (q) {
    conds.push('(j.title ILIKE ? OR j.address ILIKE ? OR j.city ILIKE ? OR c.name ILIKE ?)');
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
    `SELECT j.id, j.title, j.status, j.address, j.city, j.state, j.scheduled_date, j.created_at,
            c.id AS customer_id, c.name AS customer_name,
            u.name AS assigned_name
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN users u ON u.id = j.assigned_to_user_id
     ${where}
     ORDER BY j.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('jobs/index', {
    title: 'Jobs', activeNav: 'jobs',
    jobs, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/new', (req, res) => {
  const customers = db.all('SELECT id, name, address, city, state, zip FROM customers ORDER BY name COLLATE NOCASE ASC');
  if (customers.length === 0) {
    setFlash(req, 'error', 'You need a customer before you can create a job.');
    return res.redirect('/customers/new');
  }
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  const job = blankJob();
  const presetCustomerId = parseInt(req.query.customer_id, 10);
  if (presetCustomerId) {
    const c = customers.find(x => x.id === presetCustomerId);
    if (c) {
      job.customer_id = c.id;
      // Auto-fill site address from customer
      job.address = c.address || '';
      job.city = c.city || '';
      job.state = c.state || '';
      job.zip = c.zip || '';
    }
  }
  res.render('jobs/new', {
    title: 'New job', activeNav: 'jobs',
    job, customers, users, errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/', (req, res) => {
  const customers = db.all('SELECT id, name, address, city, state, zip FROM customers ORDER BY name COLLATE NOCASE ASC');
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  const { errors, data } = validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/new', {
      title: 'New job', activeNav: 'jobs',
      job: { id: null, ...data }, customers, users, errors, statuses: VALID_STATUSES
    });
  }
  const r = db.run(
    `INSERT INTO jobs (customer_id, title, address, city, state, zip, description, status, scheduled_date, scheduled_time, assigned_to_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.customer_id, data.title, data.address, data.city, data.state, data.zip, data.description, data.status, data.scheduled_date, data.scheduled_time, data.assigned_to_user_id]
  );
  setFlash(req, 'success', `Job "${data.title}" created.`);
  res.redirect(`/jobs/${r.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const job = db.get(
    `SELECT j.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            u.name AS assigned_name
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN users u ON u.id = j.assigned_to_user_id
     WHERE j.id = ?`,
    [req.params.id]
  );
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });

  // Pull related work orders (root WOs only — sub-WOs nest under parents)
  const workOrders = db.all(
    `SELECT id, display_number, wo_number_main, wo_number_sub, parent_wo_id, status, scheduled_date, created_at
     FROM work_orders WHERE job_id = ?
     ORDER BY wo_number_main ASC, wo_number_sub ASC`,
    [req.params.id]
  );

  res.render('jobs/show', {
    title: job.title, activeNav: 'jobs',
    job, workOrders
  });
});

router.get('/:id/edit', (req, res) => {
  const job = db.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  const customers = db.all('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE ASC');
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  res.render('jobs/edit', {
    title: `Edit ${job.title}`, activeNav: 'jobs',
    job, customers, users, errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/:id', (req, res) => {
  const job = db.get('SELECT id, title FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  const customers = db.all('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE ASC');
  const users = db.all("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");
  const { errors, data } = validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/edit', {
      title: `Edit ${job.title}`, activeNav: 'jobs',
      job: { id: job.id, ...data }, customers, users, errors, statuses: VALID_STATUSES
    });
  }
  db.run(
    `UPDATE jobs SET customer_id=?, title=?, address=?, city=?, state=?, zip=?, description=?, status=?,
       scheduled_date=?, scheduled_time=?, assigned_to_user_id=?, updated_at=now()
     WHERE id=?`,
    [data.customer_id, data.title, data.address, data.city, data.state, data.zip, data.description, data.status,
     data.scheduled_date, data.scheduled_time, data.assigned_to_user_id, req.params.id]
  );
  setFlash(req, 'success', `Job "${data.title}" updated.`);
  res.redirect(`/jobs/${req.params.id}`);
});

router.post('/:id/delete', (req, res) => {
  const job = db.get('SELECT id, title FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  const woCount = (db.get('SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?', [req.params.id]) || {}).n || 0;
  if (woCount) {
    setFlash(req, 'error', `Cannot delete "${job.title}" — it has ${woCount} work order(s).`);
    return res.redirect(`/jobs/${req.params.id}`);
  }
  db.run('DELETE FROM jobs WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', `Job "${job.title}" deleted.`);
  res.redirect('/jobs');
});

module.exports = router;
