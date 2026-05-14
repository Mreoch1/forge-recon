/**
 * Admin routes — user management + company settings.
 * Mounted at /admin under requireAuth + requireAdmin (server.js).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');

const router = express.Router();
const VALID_ROLES = ['admin', 'manager', 'worker'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

async function adminCount(excludingUserId) {
  let query = supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'admin').eq('active', 1);
  if (excludingUserId) query = query.neq('id', excludingUserId);
  const { count } = await query;
  return count || 0;
}

router.get('/users', async (req, res) => {
  const { data: users } = await supabase.from('users').select('id, email, name, role, active, created_at').order('name');
  res.render('admin/users/index', { title: 'Users', activeNav: 'admin', users: users || [] });
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
  else { const { data: dup } = await supabase.from('users').select('id').eq('email', email).maybeSingle(); if (dup) errors.email = 'Email already in use.'; }
  if (!name) errors.name = 'Name required.';
  if (!VALID_ROLES.includes(role)) errors.role = 'Invalid role.';
  if (!password) errors.password = 'Password required.';
  else if (!/^.{8,}$/.test(password)) errors.password = 'Password must be at least 8 characters.';
  else {
    const pwErrors = [];
    if (!/[A-Z]/.test(password)) pwErrors.push('one uppercase letter');
    if (!/[a-z]/.test(password)) pwErrors.push('one lowercase letter');
    if (!/\d/.test(password)) pwErrors.push('one number');
    if (!/[^A-Za-z0-9]/.test(password)) pwErrors.push('one symbol');
    if (pwErrors.length) errors.password = 'Password needs: ' + pwErrors.join(', ') + '.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/users/new', { title: 'New user', activeNav: 'admin', user: { id: null, email, name, role, active: 1 }, errors, roles: VALID_ROLES });
  }
  const hash = await bcrypt.hash(password, 10);
  const { error: insertErr } = await supabase
    .from('users')
    .insert({ email, password_hash: hash, name, role, phone: req.body.phone || null, active: 1 });
  if (insertErr) throw insertErr;
  // D-031: auto-send invite email
  try {
    const { sendUserInviteEmail } = require('../services/email');
    sendUserInviteEmail(email, name, password).catch(function(e) { console.warn('[admin] invite email failed:', e.message); });
  } catch (e) {
    console.warn('[admin] invite email setup failed:', e.message);
  }
  setFlash(req, 'success', 'User "' + name + '" created.');
  res.redirect('/admin/users');
});

router.get('/users/:id/edit', async (req, res) => {
  const { data: user, error } = await supabase.from('users').select('id, email, name, role, active').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!user) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  res.render('admin/users/edit', { title: `Edit ${user.name}`, activeNav: 'admin', user, errors: {}, roles: VALID_ROLES, isSelf: req.session.userId === user.id });
});

router.post('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  const { data: target, error: findError } = await supabase.from('users').select('*').eq('id', targetId).maybeSingle();
  if (findError) throw findError;
  if (!target) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  const errors = {};
  const email = (emptyToNull(req.body.email) || '').toLowerCase();
  const name = emptyToNull(req.body.name);
  const role = emptyToNull(req.body.role) || target.role;
  // R37k: edit form posts BOTH a hidden input (value=0) and a checkbox (value=1)
  // for the active field so unchecked state still submits. Express collects both
  // as an array ['0','1']. Previous strict === '1' check returned 0 for the array,
  // disabling every user on every save. Take the last value (checkbox wins when checked).
  const activeRaw = req.body.active;
  const activeStr = Array.isArray(activeRaw) ? activeRaw[activeRaw.length - 1] : activeRaw;
  const active = activeStr === '1' || activeStr === 'on' || activeStr === 1 ? 1 : 0;
  if (!email) errors.email = 'Email required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format.';
  else { const { data: dup } = await supabase.from('users').select('id').eq('email', email).neq('id', targetId).maybeSingle(); if (dup) errors.email = 'Email already in use.'; }
  if (!name) errors.name = 'Name required.';
  if (!VALID_ROLES.includes(role)) errors.role = 'Invalid role.';
  const wasAdmin = target.role === 'admin' && target.active === 1;
  const willBeAdmin = role === 'admin' && active === 1;
  if (wasAdmin && !willBeAdmin) { if ((await adminCount(target.id)) === 0) errors.role = 'Cannot demote or deactivate the last active admin.'; }
  if (req.session.userId === target.id && !willBeAdmin && wasAdmin) errors.role = 'You cannot demote or deactivate yourself while logged in.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/users/edit', { title: `Edit ${target.name}`, activeNav: 'admin', user: { ...target, email, name, role, active }, errors, roles: VALID_ROLES, isSelf: req.session.userId === target.id });
  }
  const { error: updateError } = await supabase.from('users').update({ name, email, role, active, phone: req.body.phone || null, updated_at: new Date().toISOString() }).eq('id', targetId);
  if (updateError) throw updateError;
  setFlash(req, 'success', `User "${name}" updated.`);
  res.redirect('/admin/users');
});

router.post('/users/:id/password', async (req, res) => {
  const { data: target, error: findError } = await supabase.from('users').select('id, name').eq('id', req.params.id).maybeSingle();
  if (findError) throw findError;
  if (!target) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  const password = req.body.password || '';
  const confirm = req.body.confirm_password || '';
  const pwErrors = [];
  if (password.length < 8) pwErrors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) pwErrors.push('one uppercase letter');
  if (!/[a-z]/.test(password)) pwErrors.push('one lowercase letter');
  if (!/\d/.test(password)) pwErrors.push('one number');
  if (!/[^A-Za-z0-9]/.test(password)) pwErrors.push('one symbol');
  if (password !== confirm) pwErrors.push('passwords must match');
  if (pwErrors.length) {
    setFlash(req, 'error', 'Password needs: ' + pwErrors.join(', ') + '.');
    return res.redirect(`/admin/users/${target.id}/edit`);
  }
  const hash = await bcrypt.hash(password, 10);
  const { error: updateError } = await supabase.from('users').update({ password_hash: hash, updated_at: new Date().toISOString() }).eq('id', target.id);
  if (updateError) throw updateError;
  setFlash(req, 'success', `Password reset for ${target.name}.`);
  res.redirect(`/admin/users/${target.id}/edit`);
});

router.post('/users/:id/delete', async (req, res) => {
  const targetId = req.params.id;
  const { data: target, error: findError } = await supabase.from('users').select('id, name, role, active').eq('id', targetId).maybeSingle();
  if (findError) throw findError;
  if (!target) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'User not found.' });
  if (req.session.userId === target.id) { setFlash(req, 'error', 'You cannot delete yourself.'); return res.redirect('/admin/users'); }
  if (target.role === 'admin' && target.active === 1 && (await adminCount(target.id)) === 0) { setFlash(req, 'error', 'Cannot delete the last active admin.'); return res.redirect('/admin/users'); }
  const { error: deleteError } = await supabase.from('users').delete().eq('id', targetId);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', `User "${target.name}" deleted.`);
  res.redirect('/admin/users');
});

// Settings
router.get('/settings', async (req, res) => {
  const { data: settings } = await supabase.from('company_settings').select('*').eq('id', 1).maybeSingle();
  res.render('admin/settings', { title: 'Company settings', activeNav: 'admin', settings: settings || {}, errors: {} });
});

router.post('/settings', async (req, res) => {
  const errors = {};
  const company_name = emptyToNull(req.body.company_name);
  if (!company_name) errors.company_name = 'Company name required.';
  const default_tax_rate = parseFloat(req.body.default_tax_rate);
  const taxRateNum = isFinite(default_tax_rate) && default_tax_rate >= 0 ? default_tax_rate : 0;
  const validTerms = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'];
  const default_payment_terms = req.body.default_payment_terms === '__custom'
    ? (emptyToNull(req.body.default_payment_terms_custom) || 'Net 30')
    : (validTerms.includes(req.body.default_payment_terms) ? req.body.default_payment_terms : 'Net 30');
  if (Object.keys(errors).length) return res.status(400).render('admin/settings', { title: 'Company settings', activeNav: 'admin', settings: { company_name, address: emptyToNull(req.body.address), city: emptyToNull(req.body.city), state: emptyToNull(req.body.state), zip: emptyToNull(req.body.zip), phone: emptyToNull(req.body.phone), email: emptyToNull(req.body.email), ein: emptyToNull(req.body.ein), default_tax_rate: taxRateNum, default_payment_terms }, errors });
  const { error: updateError } = await supabase.from('company_settings').update({
    company_name, address: emptyToNull(req.body.address), city: emptyToNull(req.body.city),
    state: emptyToNull(req.body.state), zip: emptyToNull(req.body.zip),
    phone: emptyToNull(req.body.phone), email: emptyToNull(req.body.email),
    ein: emptyToNull(req.body.ein), default_tax_rate: taxRateNum,
    default_payment_terms,
    default_conditions: emptyToNull(req.body.default_conditions),
  }).eq('id', 1);
  if (updateError) throw updateError;
  setFlash(req, 'success', 'Company settings saved.');
  res.redirect('/admin/settings');
});

// AI Usage
router.get('/ai-usage', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Total calls
  const { count: totalCalls } = await supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('entity_type', 'ai_chat')
    .eq('source', 'ai');

  // Token data — fetch all and aggregate in JS
  const { data: tokenRows } = await supabase
    .from('audit_logs')
    .select('after_json, user_id, created_at, users!left(name)')
    .eq('entity_type', 'ai_chat')
    .eq('source', 'ai')
    .order('created_at', { ascending: false })
    .limit(500);

  let totalTokens = 0;
  const userTokens = {};
  const dailyCounts = {};
  const parsedCalls = [];

  (tokenRows || []).forEach(r => {
    const p = r.after_json || {};
    const tokens = p.tokens_used || 0;
    totalTokens += Number(tokens);

    // User aggregation
    const uid = r.user_id || 0;
    if (!userTokens[uid]) userTokens[uid] = { name: r.users?.name || `User #${uid}`, count: 0, tokens: 0 };
    userTokens[uid].count++;
    userTokens[uid].tokens += Number(tokens);

    // Daily aggregation
    const d = (r.created_at || '').slice(0, 10);
    if (d) dailyCounts[d] = (dailyCounts[d] || 0) + 1;

    // Recent calls
    if (parsedCalls.length < 20) {
      parsedCalls.push({
        created_at: r.created_at,
        name: r.users?.name || `User #${uid}`,
        message: (p.message || '').slice(0, 100),
        tokens: Number(tokens),
        latency: p.latency_ms || 0,
      });
    }
  });

  const estimatedCost = totalTokens * 0.0000015;

  // Build daily data for last 14 days
  const dailyData = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dailyData.push({ date: d, count: dailyCounts[d] || 0 });
  }

  // Top users sorted by count
  const topUsers = Object.entries(userTokens)
    .map(([uid, v]) => ({ user_id: parseInt(uid), name: v.name, count: v.count, tokens: v.tokens }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.render('admin/ai-usage', {
    title: 'AI Usage', activeNav: 'admin',
    totalCalls: totalCalls || 0, totalTokens, estimatedCost, dailyData, topUsers,
    recentCalls: parsedCalls, error: null
  });
});

// admin index redirect
router.get('/', async (req, res) => { setFlash(req, 'info', 'Admin panel moved to Settings.'); res.redirect('/settings'); });

// ── Audit log ─────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const type = (req.query.type || '').trim();
  const action = (req.query.action || '').trim();

  let q = supabase
    .from('audit_logs')
    .select('*, users!audit_logs_user_id_fkey(name)', { count: 'exact' });

  if (type) q = q.eq('entity_type', type);
  if (action) q = q.eq('action', action);

  const { data: entries, count: total, error } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  // Get distinct entity types for the filter dropdown
  const { data: types } = await supabase.from('audit_logs')
    .select('entity_type')
    .order('entity_type')
    .limit(100);
  const distinctTypes = [...new Set((types || []).map(t => t.entity_type))].sort();

  res.render('admin/audit', {
    title: 'Audit Log', activeNav: 'admin',
    entries: entries || [], total: total || 0, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / limit)),
    type, action, types: distinctTypes,
  });
});
router.post('/closures/create', async (req, res) => {
  const name = (req.body.name || '').trim(); const date_start = (req.body.date_start || '').trim(); const type = req.body.type || 'holiday';
  if (!name || !date_start) { setFlash(req, 'error', 'Name and date required.'); return res.redirect('/admin'); }
  const { error: insertError } = await supabase.from('closures').insert({
    date_start, date_end: req.body.date_end || null, name, type,
    notes: req.body.notes || null, created_by_user_id: req.session.userId,
    created_at: new Date().toISOString()
  });
  if (insertError) throw insertError;
  setFlash(req, 'success', `Closure "${name}" created.`); res.redirect('/admin');
});
router.post('/closures/delete', async (req, res) => {
  const id = parseInt(req.body.closure_id, 10);
  const { data: c, error: findError } = await supabase.from('closures').select('*').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!c) { setFlash(req, 'error', 'Closure not found.'); return res.redirect('/admin'); }
  const { error: deleteError } = await supabase.from('closures').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', `Closure "${c.name}" deleted.`); res.redirect('/admin');
});

// D-062 Item 4: AI chat errors admin view
router.get('/ai-errors', async (req, res) => {
  const { data: errors, error } = await supabase
    .from('ai_chat_errors')
    .select('id, user_id, error_type, error_message, tool_name, provider, created_at')
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  res.render('admin/ai-errors', {
    title: 'AI Chat Errors',
    activeNav: 'admin',
    errors: errors || [],
  });
});

router.post('/ai-errors/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  const { error } = await supabase.from('ai_chat_errors').update({
    resolved_at: new Date().toISOString(),
    resolved_by_user_id: req.session?.userId,
    resolution_note: (note || '').trim().slice(0, 1000) || null,
  }).eq('id', id);
  if (error) throw error;
  res.redirect('/admin/ai-errors');
});

// ---- D-090: Announcements (banner changelog) ----

router.get('/announcements', async (req, res) => {
  try {
    const announcements = require('../services/announcements');
    const { data, count } = await announcements.listAll();
    res.render('admin/announcements', {
      title: 'Announcements',
      activeNav: 'admin',
      announcements: data,
      count,
    });
  } catch (e) {
    console.warn('[admin] announcements list error:', e.message);
    res.render('admin/announcements', {
      title: 'Announcements',
      activeNav: 'admin',
      announcements: [],
      count: 0,
      error: 'Could not load announcements. The app_announcements table may not exist yet — run the D-090 migration.',
    });
  }
});

router.post('/announcements', async (req, res) => {
  const announcements = require('../services/announcements');
  const { message } = req.body;
  if (!message || !message.trim()) {
    req.flash('error', 'Message is required');
    return res.redirect('/admin/announcements');
  }
  try {
    await announcements.createAnnouncement({
      message: message.trim(),
      createdById: req.session?.userId,
      createdByName: req.session?.userName || 'Admin',
    });
    req.flash('success', 'Announcement posted!');
  } catch (e) {
    console.warn('[admin] createAnnouncement error:', e.message);
    req.flash('error', 'Failed to create announcement: ' + e.message);
  }
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/deactivate', async (req, res) => {
  const announcements = require('../services/announcements');
  try {
    await announcements.deactivate(req.params.id);
    req.flash('success', 'Announcement deactivated');
  } catch (e) {
    console.warn('[admin] deactivateAnnouncement error:', e.message);
    req.flash('error', 'Failed to deactivate: ' + e.message);
  }
  res.redirect('/admin/announcements');
});

module.exports = router;
