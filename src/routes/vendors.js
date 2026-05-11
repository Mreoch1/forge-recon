
/**
 * Vendors CRUD — for bills/payables tracking.
 *
 * Routes (requireManager gated in server.js):
 *   GET    /vendors              list with search + pagination
 *   GET    /vendors/new          new form
 *   POST   /vendors              create
 *   GET    /vendors/:id          detail (with bills sub-table)
 *   GET    /vendors/:id/edit     edit form
 *   POST   /vendors/:id          update
 *   POST   /vendors/:id/delete   delete (rejected if bills exist)
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();
const PAGE_SIZE = 25;

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validate(body) {
  const errors = {};
  const name = emptyToNull(body.name);
  if (!name) errors.name = 'Name is required.';
  if (name && name.length > 200) errors.name = 'Name is too long (max 200).';
  return {
    errors,
    data: {
      name,
      email: emptyToNull(body.email),
      phone: emptyToNull(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      ein: emptyToNull(body.ein),
      default_expense_account_id: parseInt(body.default_expense_account_id, 10) || null,
      notes: emptyToNull(body.notes),
    }
  };
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  let where = '', params = [];
  if (q) {
    where = 'WHERE name ILIKE ? OR email ILIKE ? OR phone ILIKE ?';
    const like = '%' + q + '%';
    params = [like, like, like];
  }
  const total = (db.get("SELECT COUNT(*) AS n FROM vendors " + where, params) || {}).n || 0;
  const vendors = db.all(
    "SELECT id, name, email, phone, city, state FROM vendors " + where + " ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?",
    [...params, PAGE_SIZE, offset]
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  res.render('vendors/index', { title: 'Vendors', activeNav: 'vendors', vendors, q, page, totalPages, total });
});

router.get('/new', (req, res) => {
  const accounts = db.all("SELECT id, code, name FROM accounts WHERE type IN ('expense') AND active = 1 ORDER BY code ASC");
  res.render('vendors/new', { title: 'New vendor', activeNav: 'vendors', vendor: {}, errors: {}, accounts });
});

router.post('/', (req, res) => {
  const { errors, data } = validate(req.body);
  if (Object.keys(errors).length) {
    const accounts = db.all("SELECT id, code, name FROM accounts WHERE type IN ('expense') AND active = 1 ORDER BY code ASC");
    return res.status(400).render('vendors/new', { title: 'New vendor', activeNav: 'vendors', vendor: { id: null, ...data }, errors, accounts });
  }
  const r = db.run(
    "INSERT INTO vendors (name, email, phone, address, city, state, zip, ein, default_expense_account_id, notes) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [data.name, data.email, data.phone, data.address, data.city, data.state, data.zip, data.ein, data.default_expense_account_id, data.notes]
  );
  setFlash(req, 'success', 'Vendor "' + data.name + '" created.');
  res.redirect('/vendors/' + r.lastInsertRowid);
});

router.get('/:id', (req, res) => {
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', [req.params.id]);
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  const bills = db.all("SELECT id, bill_number, status, created_at FROM bills WHERE vendor_id = ? ORDER BY created_at DESC", [req.params.id]);
  const fileCountVend = (db.get('SELECT COUNT(f.id) AS n FROM files f JOIN folders fl ON fl.id = f.folder_id WHERE fl.entity_type = ? AND fl.entity_id = ?', ['vendor', vendor.id]) || {}).n || 0;
  res.render('vendors/show', { title: vendor.name, activeNav: 'vendors', vendor, bills, fileCount: fileCountVend });
});

router.get('/:id/edit', (req, res) => {
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', [req.params.id]);
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  const accounts = db.all("SELECT id, code, name FROM accounts WHERE type IN ('expense') AND active = 1 ORDER BY code ASC");
  res.render('vendors/edit', { title: 'Edit ' + vendor.name, activeNav: 'vendors', vendor, errors: {}, accounts });
});

router.post('/:id', (req, res) => {
  const { errors, data } = validate(req.body);
  const vendor = db.get('SELECT id, name FROM vendors WHERE id = ?', [req.params.id]);
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  if (Object.keys(errors).length) {
    const vendor_merged = { id: vendor.id, ...data };
    const accounts = db.all("SELECT id, code, name FROM accounts WHERE type IN ('expense') AND active = 1 ORDER BY code ASC");
    return res.status(400).render('vendors/edit', { title: 'Edit ' + (data.name || vendor.name), activeNav: 'vendors', vendor: vendor_merged, errors, accounts });
  }
  db.run(
    "UPDATE vendors SET name=?, email=?, phone=?, address=?, city=?, state=?, zip=?, ein=?, default_expense_account_id=?, notes=?, updated_at=now() WHERE id=?",
    [data.name, data.email, data.phone, data.address, data.city, data.state, data.zip, data.ein, data.default_expense_account_id, data.notes, req.params.id]
  );
  setFlash(req, 'success', 'Vendor "' + data.name + '" updated.');
  res.redirect('/vendors/' + req.params.id);
});

router.post('/:id/delete', (req, res) => {
  const vendor = db.get('SELECT id, name FROM vendors WHERE id = ?', [req.params.id]);
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  const billCount = (db.get('SELECT COUNT(*) AS n FROM bills WHERE vendor_id = ?', [req.params.id]) || {}).n || 0;
  if (billCount > 0) {
    setFlash(req, 'error', 'Cannot delete "' + vendor.name + '" — they have ' + billCount + ' bill(s).');
    return res.redirect('/vendors/' + req.params.id);
  }
  db.run('DELETE FROM vendors WHERE id = ?', [req.params.id]);
  setFlash(req, 'success', 'Vendor "' + vendor.name + '" deleted.');
  res.redirect('/vendors');
});

module.exports = router;
