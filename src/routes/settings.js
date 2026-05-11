/**
 * Settings route — per-role settings page.
 *
 *   GET   /settings                   settings page (role-adaptive)
 *   POST  /settings/profile           update own profile (name, phone, email)
 *   POST  /settings/password          change own password
 *
 * Admin-specific mutations stay at /admin/* (users, company settings, closures).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const userId = req.session.userId;
  const role = req.session.role;
  const user = await db.get('SELECT id, name, email, phone, role FROM users WHERE id = ?', [userId]);

  // Common locals
  const locals = {
    title: 'Settings', activeNav: 'settings',
    user,
    role,
  };

  // Manager sees team list
  if (role === 'admin' || role === 'manager') {
    locals.team = await db.all('SELECT id, name, email, role, active FROM users ORDER BY name COLLATE NOCASE ASC');
  }

  // Admin-only sections
  if (role === 'admin') {
    locals.userCount = (await db.get('SELECT COUNT(*) AS n FROM users WHERE active = 1') || {}).n || 0;
    locals.closureCount = (await db.get('SELECT COUNT(*) AS n FROM closures') || {}).n || 0;
    locals.holidayCount = (await db.get("SELECT COUNT(*) AS n FROM closures WHERE type = 'holiday'") || {}).n || 0;
    locals.customCount = locals.closureCount - locals.holidayCount;
    locals.closures = await db.all('SELECT * FROM closures ORDER BY date_start ASC');
  }

  res.render('settings/index', locals);
});

router.post('/profile', async (req, res) => {
  const userId = req.session.userId;
  const user = await db.get('SELECT id, name, email FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });

  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();

  if (!name) { setFlash(req, 'error', 'Name is required.'); return res.redirect('/settings'); }

  // Check email uniqueness
  if (email && email !== user.email) {
    const dup = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
    if (dup) { setFlash(req, 'error', 'Email already in use.'); return res.redirect('/settings'); }
  }

  await db.run('UPDATE users SET name=?, phone=?, email=?, updated_at=now() WHERE id=?', [name, phone || null, email || user.email, userId]);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'user', entityId: userId, action: 'profile_updated', before: { name: user.name, email: user.email }, after: { name, email }, source: 'web', userId });
  } catch(e) { console.error('audit failed:', e.message); }

  setFlash(req, 'success', 'Profile updated.');
  res.redirect('/settings');
});

router.post('/password', async (req, res) => {
  const userId = req.session.userId;
  const user = await db.get('SELECT id, password_hash FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });

  const currentPassword = req.body.current_password || '';
  const newPassword = req.body.new_password || '';

  if (!currentPassword || !newPassword) {
    setFlash(req, 'error', 'Current password and new password are required.');
    return res.redirect('/settings');
  }
  const confirm = req.body.confirm_password || '';
  const pwErrors = [];
  if (newPassword.length < 8) pwErrors.push('at least 8 characters');
  if (!/[A-Z]/.test(newPassword)) pwErrors.push('one uppercase letter');
  if (!/[a-z]/.test(newPassword)) pwErrors.push('one lowercase letter');
  if (!/\d/.test(newPassword)) pwErrors.push('one number');
  if (!/[^A-Za-z0-9]/.test(newPassword)) pwErrors.push('one symbol');
  if (newPassword !== confirm) pwErrors.push('passwords must match');
  if (pwErrors.length) {
    setFlash(req, 'error', 'Password needs: ' + pwErrors.join(', ') + '.');
    return res.redirect('/settings');
  }

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    setFlash(req, 'error', 'Current password is incorrect.');
    return res.redirect('/settings');
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await db.run('UPDATE users SET password_hash=?, updated_at=now() WHERE id=?', [hash, userId]);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'user', entityId: userId, action: 'password_changed', before: {}, after: {}, source: 'web', userId });
  } catch(e) { console.error('audit failed:', e.message); }

  setFlash(req, 'success', 'Password changed.');
  res.redirect('/settings');
});

module.exports = router;
