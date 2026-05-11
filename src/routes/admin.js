/**
 * Admin routes — user management + company settings.
 * Mounted at /admin under requireAuth + requireAdmin (server.js).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();
const VALID_ROLES = ['admin', 'manager', 'worker'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

async function adminCount(excludingUserId) {
  const params = ['admin'];
  let where = "WHERE role = ? AND active = 1";
  if (excludingUserId) { where += " AND id != ?"; params.push(excludingUserId); }
  return (await db.get(`SELECT COUNT(*) AS n FROM users ${where}`, params) || {}).n || 0;
}

router.get('/users', async (req, res) => {
  const users = await db.all(`SELECT id, email, name, role, active, created_at FROM users ORDER BY name COLLATE NOCASE ASC`);
  res.render('admin/users/index', { title: 'Users', activeNav: 'admin', users });
});

router.get('/users/new', (req, res) => {
  res.render('admin/users/new', { title: 'New user', activeNav: 'admin', user: { id: null, email: '', name: '', role: 'worker', active: 1 }, errors: {}, roles: VALID_ROLES });
});

router.post('/users', async (req, res) => {
  const errors = {};
  const email = (emptyToNull(req.body.email) || '').toLowerCase();
  const name = emptyToNull(req.body.name);
  const role = emptyToNull(req.body.role) || 'worker';
  const password = req.body.password || '';
  if (!email) errors.email = 'Email required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format.';
  else { const dup = await db.get('SELECT id FROM users WHERE email = ?', [email]); if (dup) errors.email = 'Email already in use.'; }
  if (!name) errors.name = 'Name required.';
  if (!VALID_ROLES.includes(role)) errors.role = 'Invalid role.';
  if (!password) errors.password = 'Password required.';
  else if (password.length < 8) errors.password = 'Min 8 characters.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/users/new', { title: 'New user', activeNav: 'admin', user: { id: null, email, name, role, active: 1 }, errors, roles: VALID_ROLES });
  }
  const hash = await bcrypt.hash(password, 10);
  await db.run(`INSERT INTO users (email, password_hash, name, role, phone, active) VALUES (?, ?, ?, ?, ?, 1)`, [req.body.email, hash, req.body.name, req.body.role, req.body.phone]);
  setFlash(req, 'success', `User "${name}" created.`);
  res.redirect('/admin/users');
});

router.get('/users/:id/edit', async (req, res) => {
  const user = await db.get('SELECT id, email, name, role, active FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  res.render('admin/users/edit', { title: `Edit ${user.name}`, activeNav: 'admin', user, errors: {}, roles: VALID_ROLES, isSelf: req.session.userId === user.id });
});

router.post('/users/:id', async (req, res) => {
  const target = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  const errors = {};
  const email = (emptyToNull(req.body.email) || '').toLowerCase();
  const name = emptyToNull(req.body.name);
  const role = emptyToNull(req.body.role) || target.role;
  const active = req.body.active === '1' || req.body.active === 'on' ? 1 : 0;
  if (!email) errors.email = 'Email required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format.';
  else { const dup = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, target.id]); if (dup) errors.email = 'Email already in use.'; }
  if (!name) errors.name = 'Name required.';
  if (!VALID_ROLES.includes(role)) errors.role = 'Invalid role.';
  const wasAdmin = target.role === 'admin' && target.active === 1;
  const willBeAdmin = role === 'admin' && active === 1;
  if (wasAdmin && !willBeAdmin) { if ((await adminCount(target.id)) === 0) errors.role = 'Cannot demote or deactivate the last active admin.'; }
  if (req.session.userId === target.id && !willBeAdmin && wasAdmin) errors.role = 'You cannot demote or deactivate yourself while logged in.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/users/edit', { title: `Edit ${target.name}`, activeNav: 'admin', user: { ...target, email, name, role, active }, errors, roles: VALID_ROLES, isSelf: req.session.userId === target.id });
  }
  await db.run(`UPDATE users SET name=?, email=?, role=?, active=?, phone=?, updated_at=now() WHERE id=?`, [req.body.name, req.body.email, req.body.role, active, req.body.phone, target.id]);
  setFlash(req, 'success', `User "${name}" updated.`);
  res.redirect('/admin/users');
});

router.post('/users/:id/password', async (req, res) => {
  const target = await db.get('SELECT id, name FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  const password = req.body.password || '';
  if (password.length < 8) { setFlash(req, 'error', 'Password must be at least 8 characters.'); return res.redirect(`/admin/users/${target.id}/edit`); }
  const hash = await bcrypt.hash(password, 10);
  await db.run("UPDATE users SET password_hash=?, updated_at=now() WHERE id=?", [hash, target.id]);
  setFlash(req, 'success', `Password reset for ${target.name}.`);
  res.redirect(`/admin/users/${target.id}/edit`);
});

router.post('/users/:id/delete', async (req, res) => {
  const target = await db.get('SELECT id, name, role, active FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  if (req.session.userId === target.id) { setFlash(req, 'error', 'You cannot delete yourself.'); return res.redirect('/admin/users'); }
  if (target.role === 'admin' && target.active === 1 && (await adminCount(target.id)) === 0) { setFlash(req, 'error', 'Cannot delete the last active admin.'); return res.redirect('/admin/users'); }
  await db.run('DELETE FROM users WHERE id = ?', [target.id]);
  setFlash(req, 'success', `User "${target.name}" deleted.`);
  res.redirect('/admin/users');
});

// Settings
router.get('/settings', async (req, res) => {
  const settings = await db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  res.render('admin/settings', { title: 'Company settings', activeNav: 'admin', settings, errors: {} });
});

router.post('/settings', async (req, res) => {
  const errors = {};
  const company_name = emptyToNull(req.body.company_name);
  if (!company_name) errors.company_name = 'Company name required.';
  const default_tax_rate = parseFloat(req.body.default_tax_rate);
  const taxRateNum = isFinite(default_tax_rate) && default_tax_rate >= 0 ? default_tax_rate : 0;
  const validTerms = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Custom'];
  const default_payment_terms = validTerms.includes(req.body.default_payment_terms) ? req.body.default_payment_terms : 'Net 30';
  if (Object.keys(errors).length) return res.status(400).render('admin/settings', { title: 'Company settings', activeNav: 'admin', settings: { company_name, address: emptyToNull(req.body.address), city: emptyToNull(req.body.city), state: emptyToNull(req.body.state), zip: emptyToNull(req.body.zip), phone: emptyToNull(req.body.phone), email: emptyToNull(req.body.email), ein: emptyToNull(req.body.ein), default_tax_rate: taxRateNum, default_payment_terms }, errors: {} });
  await db.run(`UPDATE company_settings SET company_name=?, address=?, city=?, state=?, zip=?, phone=?, email=?, ein=?, default_tax_rate=?, default_payment_terms=? WHERE id=1`,
    [company_name, emptyToNull(req.body.address), emptyToNull(req.body.city), emptyToNull(req.body.state), emptyToNull(req.body.zip), emptyToNull(req.body.phone), emptyToNull(req.body.email), emptyToNull(req.body.ein), taxRateNum, default_payment_terms]);
  setFlash(req, 'success', 'Company settings saved.');
  res.redirect('/admin/settings');
});

// AI Usage
router.get('/ai-usage', async (req, res) => {
  const d = require('../db/db');
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const totalCalls = (await d.get("SELECT COUNT(*) AS n FROM audit_logs WHERE source = 'ai_chat'") || {}).n || 0;
  let totalTokens = 0;
  const tokenRows = await d.all("SELECT after_json FROM audit_logs WHERE source = 'ai_chat' AND after_json IS NOT NULL LIMIT 500");
  tokenRows.forEach(r => { try { const p = typeof r.after_json === 'string' ? JSON.parse(r.after_json) : r.after_json; if (p && p.tokens_used) totalTokens += Number(p.tokens_used) || 0; } catch(e) {} });
  const estimatedCost = totalTokens * 0.0000015;
  const dailyRows = await d.all(`SELECT date(created_at) AS d, COUNT(*) AS n FROM audit_logs WHERE source = 'ai_chat' AND date(created_at) >= ? AND date(created_at) <= ? GROUP BY d ORDER BY d ASC`, [fourteenDaysAgo, today]);
  const dailyDataMap = {}; dailyRows.forEach(r => { dailyDataMap[r.d] = r.n; });
  const dailyData = []; for (let i = 13; i >= 0; i--) { const d2 = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); dailyData.push({ date: d2, count: dailyDataMap[d2] || 0 }); }
  const topUsers = await d.all(`SELECT al.user_id, u.name, COUNT(*) AS count, COALESCE(SUM(CASE WHEN json_extract(al.after_json, '$.tokens_used') IS NOT NULL THEN CAST(json_extract(al.after_json, '$.tokens_used') AS INTEGER) ELSE 0 END), 0) AS tokens FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.source = 'ai_chat' AND al.user_id IS NOT NULL GROUP BY al.user_id ORDER BY count DESC LIMIT 5`);
  const recentRows = await d.all(`SELECT al.id, al.user_id, u.name, al.after_json, al.created_at FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.source = 'ai_chat' ORDER BY al.created_at DESC LIMIT 20`);
  const parsedCalls = recentRows.map(r => { let msg = '', tokens = 0, latency = 0; try { const p = typeof r.after_json === 'string' ? JSON.parse(r.after_json) : (r.after_json || {}); msg = (p.message || '').slice(0, 100); tokens = p.tokens_used || 0; latency = p.latency_ms || 0; } catch(e) {} return { created_at: r.created_at, name: r.name || 'User #' + r.user_id, message: msg, tokens, latency }; });
  res.render('admin/ai-usage', { title: 'AI Usage', activeNav: 'admin', totalCalls, totalTokens, estimatedCost, dailyData, topUsers, recentCalls: parsedCalls, error: null });
});

module.exports = router;

// admin index redirect
router.get('/', async (req, res) => { setFlash(req, 'info', 'Admin panel moved to Settings.'); res.redirect('/settings'); });
router.post('/closures/create', async (req, res) => {
  const name = (req.body.name || '').trim(); const date_start = (req.body.date_start || '').trim(); const type = req.body.type || 'holiday';
  if (!name || !date_start) { setFlash(req, 'error', 'Name and date required.'); return res.redirect('/admin'); }
  await db.run(`INSERT INTO closures (date_start, date_end, name, type, notes, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, now())`, [date_start, req.body.date_end || null, name, type, req.body.notes || null, req.session.userId]);
  setFlash(req, 'success', `Closure "${name}" created.`); res.redirect('/admin');
});
router.post('/closures/delete', async (req, res) => {
  const id = parseInt(req.body.closure_id, 10); const c = await db.get('SELECT * FROM closures WHERE id = ?', [id]);
  if (!c) { setFlash(req, 'error', 'Closure not found.'); return res.redirect('/admin'); }
  await db.run('DELETE FROM closures WHERE id = ?', [id]); setFlash(req, 'success', `Closure "${c.name}" deleted.`); res.redirect('/admin');
});
