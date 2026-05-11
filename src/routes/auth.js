/**
 * Auth routes: GET /login, POST /login, POST /logout.
 *
 * Login validates credentials with bcrypt, sets session userId + role,
 * redirects to dashboard. Generic error message on failure (don't leak
 * whether email exists). Email is lowercased + trimmed before lookup.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

const router = express.Router();

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

router.post('/logout', async (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.redirect('/login'));
  } else {
    res.redirect('/login');
  }
});

module.exports = router;
