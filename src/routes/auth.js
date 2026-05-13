/**
 * Auth routes: GET /login, POST /login, POST /logout,
 * GET/POST /forgot-password, GET/POST /reset-password/:token.
 *
 * Login validates credentials with bcrypt, sets session userId + role,
 * redirects to dashboard. Generic error message on failure (don't leak
 * whether email exists). Email is lowercased + trimmed before lookup.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const emailService = require('../services/email');

const router = express.Router();

const HOST = process.env.APP_HOST || null; // resolved per-request when null

// F5: pre-computed bcrypt hash to compare against when the user is not found,
// equalizing response time and preventing email enumeration via timing.
// This is the bcrypt hash of a long random string the attacker cannot guess —
// real submitted passwords will never match it, but the compare still takes
// the same ~80-120ms a real compare takes, masking the absence of a user row.
const DUMMY_BCRYPT_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.OZi/HfksZSAGgaJTNZWmHmiyOXKK';

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('auth/login', {
    title: 'Sign in',
    error: null,
    email: '',
    verified: req.query.verified === '1',
    alreadyVerified: req.query.already_verified === '1'
  });
});

router.post('/login', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.status(400).render('auth/login', {
      title: 'Sign in',
      error: 'Email and password are required.',
      email
    });
  }

  // Input hardening: reject malformed email before any Supabase query
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(401).render('auth/login', {
      title: 'Sign in',
      error: 'Invalid email or password.',
      email
    });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .eq('active', 1)
    .maybeSingle();
  if (error) throw error;

  // F5: Always run bcrypt.compare to equalize response time. If `user` is
  // null we still compare against a fixed dummy hash so the timing of a
  // missing user matches that of an existing user with the wrong password.
  const hashToCheck = user ? user.password_hash : DUMMY_BCRYPT_HASH;
  const passwordMatches = await bcrypt.compare(password, hashToCheck);
  const ok = !!user && passwordMatches;

  if (!ok) {
    // F10: audit failed login attempts so we have a forensic trail for
    // credential-stuffing or brute-force attempts. We do NOT branch on whether
    // the user existed — that branch is what F5 just equalized. Logged
    // server-side only; nothing is returned to the client beyond the generic
    // error message.
    try {
      const { writeAudit } = require('../services/audit');
      // writeAudit's schema doesn't have a generic metadata column — we pack
      // the IP/UA/email into the `after` JSON snapshot so it lands in
      // audit_logs.after_json for forensics.
      writeAudit({
        entityType: 'user',
        entityId: user ? user.id : 0,
        action: 'login_failed',
        before: null,
        after: { email, ip: req.ip, ua: req.get('user-agent') || '' },
        source: 'user',
        userId: null,
      });
    } catch (_) { /* never let auditing break a login */ }

    return res.status(401).render('auth/login', {
      title: 'Sign in',
      error: 'Invalid email or password.',
      email
    });
  }

  if (!user.email_verified) {
    return res.status(401).render('auth/login', {
      title: 'Sign in',
      error: 'Please verify your email before signing in. <a href="/resend-verification" class="underline">Resend verification email</a>.',
      email
    });
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  setFlash(req, 'success', `Welcome back, ${user.name}.`);
  res.redirect('/');
});

// ── Logout ────────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  if (req.session) {
    try { req.session.destroy(() => { try { res.redirect('/login'); } catch(e) { /* ignore */ } }); } catch(e) { req.session = null; res.redirect('/login'); }
  } else {
    res.redirect('/login');
  }
});

// ── Forgot password ───────────────────────────────────────────────────────────

router.get('/forgot-password', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('auth/forgot-password', {
    title: 'Forgot password',
    flash: req.flash ? { success: req.flash('success'), error: req.flash('error') } : {},
    errors: {}
  });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) {
    return res.render('auth/forgot-password', {
      title: 'Forgot password',
      errors: { email: 'Email is required.' }
    });
  }

  // Input hardening: reject malformed email before any Supabase query
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render('auth/forgot-password', {
      title: 'Forgot password', errors: { email: 'Invalid email format.' }
    });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, name, email')
    .eq('email', email)
    .eq('active', 1)
    .maybeSingle();
  if (error) throw error;

  if (user) {
    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const { error: insertError } = await supabase
      .from('password_reset_tokens')
      .insert({ user_id: user.id, token, expires_at: expiresAt, created_at: new Date().toISOString() });
    if (insertError) throw insertError;

    // Send email — pass raw token; email.js builds the full URL via PUBLIC_BASE_URL.
    try {
      await emailService.sendPasswordResetEmail(user.email, user.name, token);
    } catch (e) {
      console.warn('[auth] reset email send failed:', e.message);
    }

    // Audit
    try {
      const { writeAudit } = require('../services/audit');
      writeAudit({ entityType: 'user', entityId: user.id, action: 'password_reset_requested', before: null, after: null, source: 'user', userId: user.id });
    } catch(e) {}
  }

  // Always return same message (prevent enumeration)
  setFlash(req, 'success', 'If that email is registered, you\'ll receive a reset link shortly.');
  res.redirect('/login');
});

// ── Reset password ────────────────────────────────────────────────────────────

router.get('/reset-password/:token', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const token = req.params.token;
  const now = new Date().toISOString();
  const { data: row, error } = await supabase
    .from('password_reset_tokens')
    .select('*')
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', now)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    return res.status(400).render('error', {
      title: 'Invalid link',
      code: 400,
      message: 'This reset link is invalid or expired.',
      actionLink: '/forgot-password',
      actionLabel: 'Request a new one'
    });
  }
  res.render('auth/reset-password', { title: 'Reset password', token, error: null, flash: {} });
});

router.post('/reset-password/:token', async (req, res) => {
  const token = req.params.token;
  const now = new Date().toISOString();
  const { data: row, error } = await supabase
    .from('password_reset_tokens')
    .select('*')
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', now)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    return res.status(400).render('error', { title: 'Invalid link', code: 400, message: 'This reset link is invalid or expired.', actionLink: '/forgot-password', actionLabel: 'Request a new one' });
  }

  const password = req.body.new_password || '';
  const confirm = req.body.confirm_password || '';
  const errors = [];

  // Validate rules
  if (password.length < 8) errors.push('At least 8 characters.');
  if (!/[A-Z]/.test(password)) errors.push('At least one uppercase letter.');
  if (!/[a-z]/.test(password)) errors.push('At least one lowercase letter.');
  if (!/\d/.test(password)) errors.push('At least one number.');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('At least one symbol.');
  if (password !== confirm) errors.push('Passwords do not match.');

  if (errors.length) {
    return res.render('auth/reset-password', { title: 'Reset password', token, error: errors.join('<br>'), flash: {} });
  }

  const hash = await bcrypt.hash(password, 10);
  const { error: updateUserError } = await supabase
    .from('users')
    .update({ password_hash: hash })
    .eq('id', row.user_id);
  if (updateUserError) throw updateUserError;
  const { error: updateTokenError } = await supabase
    .from('password_reset_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id);
  if (updateTokenError) throw updateTokenError;

  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'user', entityId: row.user_id, action: 'password_reset', before: null, after: null, source: 'user', userId: row.user_id });
  } catch(e) {}

  setFlash(req, 'success', 'Password updated. Sign in with your new password.');
  res.redirect('/login');
});

module.exports = router;
