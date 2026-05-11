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
  db.run(`INSERT INTO users (email, password_hash, name, role, phone, active) VALUES (?, ?, ?, ?, ?, 1)`,
    [req.body.email, hash, req.body.name, req.body.role, req.body.phone]);
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

  db.run(`UPDATE users SET name=?, email=?, role=?, active=?, phone=?, updated_at=now() WHERE id=?`,
    [req.body.name, req.body.email, req.body.role, active, req.body.phone, userId]);
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

// AI Usage dashboard (admin only)
router.get('/ai-usage', (req, res) => {
  const db = require('../db/db');
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Total stats
  const totalCalls = (db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE source = 'ai_chat'") || {}).n || 0;
  // Token count stored in after_json — try to extract
  let totalTokens = 0;
  const tokenRows = db.all("SELECT after_json FROM audit_logs WHERE source = 'ai_chat' AND after_json IS NOT NULL LIMIT 500");
  tokenRows.forEach(r => {
    try {
      const parsed = typeof r.after_json === 'string' ? JSON.parse(r.after_json) : r.after_json;
      if (parsed && parsed.tokens_used) totalTokens += Number(parsed.tokens_used) || 0;
    } catch(e) {}
  });
  const estimatedCost = totalTokens * 0.0000015; // ~$1.50/1M tokens at DeepSeek rates

  // Daily aggregation (14-day)
  const dailyRows = db.all(`SELECT date(created_at) AS d, COUNT(*) AS n FROM audit_logs
    WHERE source = 'ai_chat' AND date(created_at) >= ? AND date(created_at) <= ?
    GROUP BY d ORDER BY d ASC`, [fourteenDaysAgo, today]);
  const dailyDataMap = {};
  dailyRows.forEach(r => { dailyDataMap[r.d] = r.n; });
  const dailyData = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dailyData.push({ date: d, count: dailyDataMap[d] || 0 });
  }

  // Top users
  const topUsers = db.all(`SELECT al.user_id, u.name, COUNT(*) AS count, COALESCE(SUM(
    CASE WHEN json_extract(al.after_json, '$.tokens_used') IS NOT NULL
      THEN CAST(json_extract(al.after_json, '$.tokens_used') AS INTEGER) ELSE 0 END
  ), 0) AS tokens
    FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.source = 'ai_chat' AND al.user_id IS NOT NULL
    GROUP BY al.user_id ORDER BY count DESC LIMIT 5`);

  // Recent calls
  const recentCalls = db.all(`SELECT al.id, al.user_id, u.name, al.after_json, al.created_at
    FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.source = 'ai_chat' ORDER BY al.created_at DESC LIMIT 20`);
  const parsedCalls = recentCalls.map(r => {
    let msg = '', tokens = 0, latency = 0;
    try {
      const parsed = typeof r.after_json === 'string' ? JSON.parse(r.after_json) : (r.after_json || {});
      msg = (parsed.message || '').slice(0, 100);
      tokens = parsed.tokens_used || 0;
      latency = parsed.latency_ms || 0;
    } catch(e) {}
    return { created_at: r.created_at, name: r.name || 'User #' + r.user_id, message: msg, tokens, latency };
  });

  res.render('admin/ai-usage', {
    title: 'AI Usage', activeNav: 'admin',
    totalCalls, totalTokens, estimatedCost,
    dailyData, topUsers, recentCalls: parsedCalls,
    error: null
  });
});

module.exports = router;

// --- admin index → redirect to /settings ---
router.get('/', (req, res) => {
  setFlash(req, 'info', 'Admin panel moved to Settings.');
  res.redirect('/settings');
});

// --- closures CRUD moved inline ---
router.post('/closures/create', (req, res) => {
  const name = (req.body.name || '').trim();
  const date_start = (req.body.date_start || '').trim();
  const type = req.body.type || 'holiday';
  if (!name || !date_start) {
    setFlash(req, 'error', 'Name and date required.');
    return res.redirect('/admin');
  }
  db.run(`INSERT INTO closures (date_start, date_end, name, type, notes, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, now())`,
    [date_start, req.body.date_end || null, name, type, req.body.notes || null, req.session.userId]);
  setFlash(req, 'success', `Closure "${name}" created.`);
  res.redirect('/admin');
});

router.post('/closures/delete', (req, res) => {
  const id = parseInt(req.body.closure_id, 10);
  const c = db.get('SELECT * FROM closures WHERE id = ?', [id]);
  if (!c) { setFlash(req, 'error', 'Closure not found.'); return res.redirect('/admin'); }
  db.run('DELETE FROM closures WHERE id = ?', [id]);
  setFlash(req, 'success', `Closure "${c.name}" deleted.`);
  res.redirect('/admin');
});
