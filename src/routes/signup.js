/**
 * Public signup + email verification routes (R30).
 *
 *   GET  /signup                 — branded form
 *   POST /signup                 — validate, insert user, send verification email
 *   GET  /verify-email/:token    — verify link from email
 *   POST /resend-verification    — resend verification email
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const supabase = require('../db/supabase');
const emailService = require('../services/email');

const router = express.Router();

const VALID_ROLES = ['admin', 'manager', 'worker'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validatePassword(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('At least 8 characters.');
  if (!/[A-Z]/.test(password)) errors.push('One uppercase letter.');
  if (!/[a-z]/.test(password)) errors.push('One lowercase letter.');
  if (!/[0-9]/.test(password)) errors.push('One number.');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('One special character.');
  return errors;
}

function validateSignup(body) {
  const errors = {};
  const email = (body.email || '').toLowerCase().trim();
  const name = emptyToNull(body.name);
  const password = body.password || '';
  const confirm = body.password_confirm || '';

  if (!email) errors.email = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format.';

  if (!name) errors.name = 'Name is required.';

  const pwErrors = validatePassword(password);
  if (pwErrors.length) errors.password = pwErrors.join(' ');
  if (password !== confirm) errors.password_confirm = 'Passwords do not match.';

  return { errors, data: { email, name, password } };
}

router.get('/signup', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('auth/signup', {
    title: 'Sign up — FORGE',
    errors: {},
    values: {},
  });
});

router.post('/signup', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const { errors, data } = validateSignup(req.body);

  if (Object.keys(errors).length) {
    return res.status(400).render('auth/signup', {
      title: 'Sign up — FORGE',
      errors,
      values: { email: req.body.email, name: req.body.name },
    });
  }

  // No-enumeration: check if email already exists
  const { data: existing } = await supabase.from('users').select('id').eq('email', data.email).maybeSingle();
  if (existing) {
    // Enumerate? No — just show "check your email" (no-enumeration)
    return res.render('auth/check-email', {
      title: 'Check your email — FORGE',
      email: data.email,
    });
  }

  const hash = await bcrypt.hash(data.password, 10);
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  const { error: insertError } = await supabase.from('users').insert({
    email: data.email,
    password_hash: hash,
    name: data.name,
    role: 'worker',
    active: 1,
    email_verified: false,
    verification_token: token,
    verification_expires_at: expiresAt,
  });
  if (insertError) throw insertError;

  // Send verification email. Log full error info so we can debug SMTP failures
  // without crashing the request — but DO surface SMTP response codes when present.
  try {
    await emailService.sendVerificationEmail(data.email, data.name, token);
  } catch (e) {
    console.error('[signup] sendVerificationEmail failed for', data.email, '|',
      'message:', e.message, '|',
      'code:', e.code || 'n/a', '|',
      'response:', e.response || 'n/a', '|',
      'responseCode:', e.responseCode || 'n/a', '|',
      'command:', e.command || 'n/a');
    if (process.env.NODE_ENV !== 'production' || process.env.EMAIL_SMOKE_TEST === '1') {
      console.error('[signup] full stack:', e.stack);
    }
  }

  res.render('auth/check-email', {
    title: 'Check your email — FORGE',
    email: data.email,
  });
});

router.get('/verify-email/:token', async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email')
    .eq('verification_token', req.params.token)
    .gt('verification_expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw error;

  if (!user) {
    return res.render('auth/verify-email-error', {
      title: 'Verification failed — FORGE',
      error: 'This link is invalid or expired. Request a new verification email below.',
      email: '',
    });
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({ email_verified: true, verification_token: null, verification_expires_at: null })
    .eq('id', user.id);
  if (updateError) throw updateError;

  res.redirect('/login?verified=1');
});

router.post('/resend-verification', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) {
    return res.status(400).render('auth/check-email', {
      title: 'Check your email — FORGE',
      email: '',
      error: 'Enter your email address.',
    });
  }

  // Look up the user (any verification state) — we differentiate verified vs unverified responses.
  // Non-existent emails fall through to the generic "check your email" page (no-enumeration preserved).
  const { data: user } = await supabase
    .from('users')
    .select('id, name, email_verified')
    .eq('email', email)
    .maybeSingle();

  // Already verified → send them to login with a helpful banner instead of pretending we sent a mail.
  if (user && user.email_verified === true) {
    return res.redirect('/login?already_verified=1');
  }

  if (user && user.email_verified === false) {
    const token = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    await supabase
      .from('users')
      .update({ verification_token: token, verification_expires_at: expiresAt })
      .eq('id', user.id);

    try {
      await emailService.sendVerificationEmail(email, user.name, token);
    } catch (e) {
      console.error('[resend] sendVerificationEmail failed for', email, '|',
        'message:', e.message, '|',
        'code:', e.code || 'n/a', '|',
        'response:', e.response || 'n/a', '|',
        'responseCode:', e.responseCode || 'n/a');
    }
  }

  // No-enumeration: when the email isn't in our system, we still render check-email.
  res.render('auth/check-email', {
    title: 'Check your email — FORGE',
    email,
  });
});

module.exports = router;
