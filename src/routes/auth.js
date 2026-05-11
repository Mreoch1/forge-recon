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
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const emailService = require('../services/email');

const router = express.Router();

const HOST = process.env.APP_HOST || 'http://localhost:3001';

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('auth/login', {
    title: 'Sign in',
    error: null,
    email: ''
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

  const user = await db.get(
    'SELECT * FROM users WHERE email = ? AND active = 1',
    [email]
  );

  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !ok) {
    return res.status(401).render('auth/login', {
      title: 'Sign in',
      error: 'Invalid email or password.',
      email
    });
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  setFlash(req, 'success', `Welcome back, ${user.name}.`);
  res.redirect('/');
});

// ── Logout ────────────────────────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.redirect('/login'));
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

  const user = await db.get('SELECT id, name, email FROM users WHERE email = ? AND active = 1', [email]);

  if (user) {
    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    await db.run(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at, created_at) VALUES (?, ?, ?, now())`,
      [user.id, token, expiresAt]
    );

    // Send email
    const resetUrl = `${HOST}/reset-password/${token}`;
    try {
      await emailService.sendPasswordResetEmail(user.email, user.name, resetUrl);
    } catch (e) {
      console.warn('[auth] reset email send failed:', e.message);
    }

    // Audit
    try {
      const { writeAudit } = require('../services/audit');
      writeAudit({ entityType: 'user', entityId: user.id, action: 'password_reset_requested', before: null, after: null, source: 'web', userId: user.id });
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
  const row = await db.get(
    `SELECT * FROM password_reset_tokens WHERE token = ? AND used_at IS NULL AND expires_at > now()`,
    [token]
  );
  if (!row) {
    return res.status(400).render('error', {
      title: 'Invalid link',
      code: 400,
      message: 'This reset link is invalid or expired. <a href="/forgot-password" class="text-recon-red hover:underline">Request a new one</a>.'
    });
  }
  res.render('auth/reset-password', { title: 'Reset password', token, error: null, flash: {} });
});

router.post('/reset-password/:token', async (req, res) => {
  const token = req.params.token;
  const row = await db.get(
    `SELECT * FROM password_reset_tokens WHERE token = ? AND used_at IS NULL AND expires_at > now()`,
    [token]
  );
  if (!row) {
    return res.status(400).render('error', { title: 'Invalid link', code: 400, message: 'This reset link is invalid or expired.' });
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
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, row.user_id]);
  await db.run('UPDATE password_reset_tokens SET used_at = now() WHERE id = ?', [row.id]);

  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'user', entityId: row.user_id, action: 'password_reset', before: null, after: null, source: 'web', userId: row.user_id });
  } catch(e) {}

  setFlash(req, 'success', 'Password updated. Sign in with your new password.');
  res.redirect('/login');
});

module.exports = router;
