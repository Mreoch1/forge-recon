/**
 * Settings route - per-role settings page.
 *
 *   GET   /settings                   settings page (role-adaptive)
 *   POST  /settings/profile           update own profile (name, phone, email)
 *   POST  /settings/password          change own password
 *
 * Admin-specific mutations stay at /admin/* (users, company settings, closures).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const userId = req.session.userId;
  const role = req.session.role;
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, name, email, phone, role')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) throw userErr;

  // Common locals
  const locals = {
    title: 'Settings', activeNav: 'settings',
    user,
    role,
  };

  // Manager sees team list
  if (role === 'admin' || role === 'manager') {
    const { data: team, error: teamErr } = await supabase
      .from('users')
      .select('id, name, email, role, active')
      .order('name', { ascending: true });
    if (teamErr) throw teamErr;
    locals.team = team || [];
  }

  // Admin-only sections
  if (role === 'admin') {
    const [{ count: userCount }, { count: closureCount }, { count: holidayCount }, { data: closures, error: closuresErr }] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('closures').select('*', { count: 'exact', head: true }),
      supabase.from('closures').select('*', { count: 'exact', head: true }).eq('type', 'holiday'),
      supabase.from('closures').select('*').order('date_start', { ascending: true }),
    ]);
    if (closuresErr) throw closuresErr;
    locals.userCount = userCount || 0;
    locals.closureCount = closureCount || 0;
    locals.holidayCount = holidayCount || 0;
    locals.customCount = (closureCount || 0) - (holidayCount || 0);
    locals.closures = closures || [];
  }

  res.render('settings/index', locals);
});

router.post('/profile', async (req, res) => {
  const userId = req.session.userId;
  const { data: user, error: findErr } = await supabase
    .from('users')
    .select('id, name, email')
    .eq('id', userId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!user) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });

  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();

  if (!name) { setFlash(req, 'error', 'Name is required.'); return res.redirect('/settings'); }

  // Check email uniqueness
  if (email && email !== user.email) {
    const { data: dup, error: dupErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .neq('id', userId)
      .maybeSingle();
    if (dupErr) throw dupErr;
    if (dup) { setFlash(req, 'error', 'Email already in use.'); return res.redirect('/settings'); }
  }

  const { error: updErr } = await supabase
    .from('users')
    .update({
      name,
      phone: phone || null,
      email: email || user.email,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (updErr) throw updErr;

  try {
    const { writeAudit } = require('../services/audit');
    await writeAudit({
      entityType: 'user', entityId: userId, action: 'profile_updated',
      before: { name: user.name, email: user.email },
      after: { name, email },
      source: 'web', userId,
    });
  } catch (e) { console.error('audit failed:', e.message); }

  setFlash(req, 'success', 'Profile updated.');
  res.redirect('/settings');
});

router.post('/password', async (req, res) => {
  const userId = req.session.userId;
  const { data: user, error: findErr } = await supabase
    .from('users')
    .select('id, password_hash')
    .eq('id', userId)
    .maybeSingle();
  if (findErr) throw findErr;
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
  const { error: updErr } = await supabase
    .from('users')
    .update({ password_hash: hash, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (updErr) throw updErr;

  try {
    const { writeAudit } = require('../services/audit');
    await writeAudit({
      entityType: 'user', entityId: userId, action: 'password_changed',
      before: {}, after: {}, source: 'web', userId,
    });
  } catch (e) { console.error('audit failed:', e.message); }

  setFlash(req, 'success', 'Password changed.');
  res.redirect('/settings');
});

module.exports = router;
