/**
 * Customers CRUD.
 *
 * Routes (all gated by requireAuth in server.js):
 *   GET    /customers              list with search + pagination
 *   GET    /customers/new          new form
 *   POST   /customers              create
 *   GET    /customers/:id          detail (with related jobs)
 *   GET    /customers/:id/edit     edit form
 *   POST   /customers/:id          update
 *   POST   /customers/:id/delete   delete (rejected if jobs exist)
 *
 * Validation: name is required. Email/phone optional but format-checked
 * if provided. Returns 400 with errors object back to the form on fail.
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();

const PAGE_SIZE = 25;

// --- helpers ---

function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validateCustomer(body) {
  const errors = {};
  const name = trim(body.name);
  if (!name) errors.name = 'Name is required.';
  if (name && name.length > 200) errors.name = 'Name is too long (max 200).';

  const email = emptyToNull(body.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Email format looks invalid.';
  }

  return {
    errors,
    data: {
      name,
      email,
      phone: emptyToNull(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      notes: emptyToNull(body.notes),
    }
  };
}

function blankCustomer() {
  return {
    id: null, name: '', email: '', phone: '',
    address: '', city: '', state: '', zip: '', notes: ''
  };
}

// --- routes ---

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let where = '';
  let params = [];
  if (q) {
    where = 'WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR city LIKE ?';
    const like = `%${q}%`;
    params = [like, like, like, like];
  }

  const total = (db.get(`SELECT COUNT(*) AS n FROM customers ${where}`, params) || {}).n || 0;
  const customers = db.all(
    `SELECT id, name, email, phone, city, state
     FROM customers ${where}
     ORDER BY name COLLATE NOCASE ASC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  res.render('customers/index', {
    title: 'Customers',
    activeNav: 'customers',
    customers, q, page, totalPages, total
  });
});

router.get('/new', (req, res) => {
  res.render('customers/new', {
    title: 'New customer',
    activeNav: 'customers',
    customer: blankCustomer(),
    errors: {}
  });
});

router.post('/', (req, res) => {
  const { errors, data } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('customers/new', {
      title: 'New customer',
      activeNav: 'customers',
      customer: { id: null, ...data },
      errors
    });
  }
  const r = db.run(
    `INSERT INTO customers (name, email, phone, address, city, state, zip, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.name, data.email, data.phone, data.address, data.city, data.state, data.zip, data.notes]
  );
  setFlash(req, 'success', `Customer "${data.name}" created.`);
  res.redirect(`/customers/${r.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
  if (!customer) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  }
  const jobs = db.all(
    `SELECT id, title, status, address, city, state, created_at
     FROM jobs WHERE customer_id = ?
     ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.render('customers/show', {
    title: customer.name,
    activeNav: 'customers',
    customer, jobs
  });
});

router.get('/:id/edit', (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [req.params.id]);
  if (!customer) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  }
  res.render('customers/edit', {
    title: `Edit ${customer.name}`,
    activeNav: 'customers',
    customer, errors: {}
  });
});

router.post('/:id', (req, res) => {
  const customer = db.get('SELECT id, name FROM customers WHERE id = ?', [req.params.id]);
  if (!customer) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  }
  const { errors, data } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('customers/edit', {
      title: `Edit ${customer.name}`,
      activeNav: 'customers',
      customer: { id: customer.id, ...data },
      errors
    });
  }
  db.run(
    `UPDATE customers
     SET name=?, email=?, phone=?, address=?, city=?, state=?, zip=?, notes=?, updated_at=datetime('now')
     WHERE id=?`,
    [data.name, data.email, data.phone, data.address, data.city, data.state, data.zip, data.notes, req.params.id]
  );
  setFlash(req, 'success', `Customer "${data.name}" updated.`);
  res.redirect(`/customers/${req.params.id}`);
});

router.post('/:id/delete', (req, res) => {
  const customer = db.get('SELECT id, name FROM customers WHERE id = ?', [req.params.id]);
  if (!customer) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  }
  const jobCount = (db.get('SELECT COUNT(*) AS n FROM jobs WHERE customer_id = ?', [req.params.id]) || {}).n || 0;
  if (jobCount > 0) {
    setFlash(req, 'error', `Cannot delete "${customer.name}" — they have ${jobCount} job(s). Delete or reassign jobs first.`);
    return res.redirect(`/customers/${req.params.id}`);
  }
  db.run('DELETE FROM customers WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', `Customer "${customer.name}" deleted.`);
  res.redirect('/customers');
});

module.exports = router;
