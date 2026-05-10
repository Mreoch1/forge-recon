/**
 * Admin routes — user management + company settings.
 *
 * Mounted at /admin under requireAuth + requireAdmin (server.js).
 *
 *   GET   /admin/users
 *   GET   /admin/users/new
 *   POST  /admin/users
 *   GET   /admin/users/:id/edit
 *   POST  /admin/users/:id              update name / email / role / active
 *   POST  /admin/users/:id/password     change password
 *   POST  /admin/users/:id/delete       delete (cannot delete self or last admin)
 *
 *   GET   /admin/settings
 *   POST  /admin/settings               update company singleton
 *
 * Self-protection: the currently logged-in admin can't delete themselves
 * or strip their own admin role. We also refuse to delete or demote the
 * LAST admin so the system can't be locked out.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();

// v0.5: role enum is admin / manager / worker (schema CHECK constraint).
// 'staff' is deprecated — auto-migrated to 'manager' on first save.
const VALID_ROLES = ['admin', 'manager', 'worker'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function adminCount(excludingUserId) {
  const params = ['admin'];
  let where = "WHERE role = ? AND active = 1";
  if (excludingUserId) {
    where += " AND id != ?";
    params.push(excludingUserId);
  }
  return (db.get(`SELECT COUNT(*) AS n FROM users ${where}`, params) || {}).n || 0;
}

// --- users ---

router.get('/users', (req, res) => {
  const users = db.all(
    `SELECT id, email, name, role, active, created_at FROM users ORDER BY name COLLATE NOCASE ASC`
  );
  res.render('admin/users/index', {
    title: 'Users',
    activeNav: 'admin',
    users
  });
});

router.get('/users/new', (req, res) => {
  res.render('admin/users/new', {
    title: 'New user',
    activeNav: 'admin',
    user: { id: null, email: '', name: '', role: 'worker', active: 1 },
    errors: {},
    roles: VALID_ROLES,
  });
});

router.post('/users', async (req, res) => {
  const errors = {};
  const email = (emptyToNull(req.body.email) || '').toLowerCase();
  const name = emptyToNull(req.body.name);
  const role = emptyToNull(req.body.role) || 'worker';
  const password = req.body.password || '';

  if (!email) errors.email = 'Email required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format.';
  else {
    const dup = db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (dup) errors.email = 'Email already in use.';
  }

  if (!name) errors.name = 'Name required.';
  if (!VALID_ROLES.includes(role)) errors.role = 'Invalid role.';
  if (!password) errors.password = 'Password required.';
  else if (password.length < 8) errors.password = 'Min 8 characters.';

  if (Object.keys(errors).length) {
    return res.status(400).render('admin/users/new', {
      title: 'New user',
      activeNav: 'admin',
      user: { id: null, email, name, role, active: 1 },
      errors,
      roles: VALID_ROLES,
    });
  }

  const hash = await bcrypt.hash(password, 10);
  db.run(
    `INSERT INTO users (email, password_hash, name, role, active) VALUES (?, ?, ?, ?, 1)`,
    [email, hash, name, role]
  );
  setFlash(req, 'success', `User "${name}" created.`);
  res.redirect('/admin/users');
});

router.get('/users/:id/edit', (req, res) => {
  const user = db.get('SELECT id, email, name, role, active FROM users WHERE id = ?', [req.params.id]);
  if (!user) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  }
  res.render('admin/users/edit', {
    title: `Edit ${user.name}`,
    activeNav: 'admin',
    user, errors: {}, roles: VALID_ROLES,
    isSelf: req.session.userId === user.id
  });
});

router.post('/users/:id', (req, res) => {
  const target = db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  }

  const errors = {};
  const email = (emptyToNull(req.body.email) || '').toLowerCase();
  const name = emptyToNull(req.body.name);
  const role = emptyToNull(req.body.role) || target.role;
  const active = req.body.active === '1' || req.body.active === 'on' ? 1 : 0;

  if (!email) errors.email = 'Email required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format.';
  else {
    const dup = db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, target.id]);
    if (dup) errors.email = 'Email already in use.';
  }
  if (!name) errors.name = 'Name required.';
  if (!VALID_ROLES.includes(role)) errors.role = 'Invalid role.';

  // Self-protection: don't let the last admin demote / deactivate themselves
  const wasAdmin = target.role === 'admin' && target.active === 1;
  const willBeAdmin = role === 'admin' && active === 1;
  if (wasAdmin && !willBeAdmin) {
    if (adminCount(target.id) === 0) {
      errors.role = 'Cannot demote or deactivate the last active admin.';
    }
  }
  if (req.session.userId === target.id && !willBeAdmin && wasAdmin) {
    errors.role = 'You cannot demote or deactivate yourself while logged in.';
  }

  if (Object.keys(errors).length) {
    return res.status(400).render('admin/users/edit', {
      title: `Edit ${target.name}`,
      activeNav: 'admin',
      user: { ...target, email, name, role, active },
      errors, roles: VALID_ROLES,
      isSelf: req.session.userId === target.id
    });
  }

  db.run(
    `UPDATE users SET email=?, name=?, role=?, active=?, updated_at=datetime('now') WHERE id=?`,
    [email, name, role, active, target.id]
  );
  setFlash(req, 'success', `User "${name}" updated.`);
  res.redirect('/admin/users');
});

router.post('/users/:id/password', async (req, res) => {
  const target = db.get('SELECT id, name FROM users WHERE id = ?', [req.params.id]);
  if (!target) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  }
  const password = req.body.password || '';
  if (password.length < 8) {
    setFlash(req, 'error', 'Password must be at least 8 characters.');
    return res.redirect(`/admin/users/${target.id}/edit`);
  }
  const hash = await bcrypt.hash(password, 10);
  db.run('UPDATE users SET password_hash=?, updated_at=datetime(\'now\') WHERE id=?', [hash, target.id]);
  setFlash(req, 'success', `Password reset for ${target.name}.`);
  res.redirect(`/admin/users/${target.id}/edit`);
});

router.post('/users/:id/delete', (req, res) => {
  const target = db.get('SELECT id, name, role, active FROM users WHERE id = ?', [req.params.id]);
  if (!target) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  }
  if (req.session.userId === target.id) {
    setFlash(req, 'error', 'You cannot delete yourself.');
    return res.redirect('/admin/users');
  }
  if (target.role === 'admin' && target.active === 1 && adminCount(target.id) === 0) {
    setFlash(req, 'error', 'Cannot delete the last active admin.');
    return res.redirect('/admin/users');
  }
  db.run('DELETE FROM users WHERE id = ?', [target.id]);
  setFlash(req, 'success', `User "${target.name}" deleted.`);
  res.redirect('/admin/users');
});

// --- settings ---

router.get('/settings', (req, res) => {
  const settings = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  res.render('admin/settings', {
    title: 'Company settings',
    activeNav: 'admin',
    settings, errors: {},
  });
});

router.post('/settings', (req, res) => {
  const errors = {};
  const company_name = emptyToNull(req.body.company_name);
  if (!company_name) errors.company_name = 'Company name required.';

  const default_tax_rate = parseFloat(req.body.default_tax_rate);
  const taxRateNum = isFinite(default_tax_rate) && default_tax_rate >= 0 ? default_tax_rate : 0;

  const validTerms = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Custom'];
  const default_payment_terms = validTerms.includes(req.body.default_payment_terms)
    ? req.body.default_payment_terms : 'Net 30';

  const data = {
    company_name,
    address: emptyToNull(req.body.address),
    city: emptyToNull(req.body.city),
    state: emptyToNull(req.body.state),
    zip: emptyToNull(req.body.zip),
    phone: emptyToNull(req.body.phone),
    email: emptyToNull(req.body.email),
    ein: emptyToNull(req.body.ein),
    default_tax_rate: taxRateNum,
    default_payment_terms,
  };

  if (Object.keys(errors).length) {
    return res.status(400).render('admin/settings', {
      title: 'Company settings',
      activeNav: 'admin',
      settings: { ...data }, errors,
    });
  }

  db.run(
    `UPDATE company_settings SET
       company_name=?, address=?, city=?, state=?, zip=?, phone=?, email=?, ein=?,
       default_tax_rate=?, default_payment_terms=?
     WHERE id=1`,
    [
      data.company_name, data.address, data.city, data.state, data.zip,
      data.phone, data.email, data.ein,
      data.default_tax_rate, data.default_payment_terms,
    ]
  );
  setFlash(req, 'success', 'Company settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
