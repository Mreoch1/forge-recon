/**
 * closures.js — Redirect to admin panel (closures now managed inline).
 */
const express = require('express');
const router = express.Router();
const { setFlash } = require('../middleware/auth');

router.all('*', (req, res) => {
  setFlash(req, 'info', 'Closures now managed in the Admin panel.');
  res.redirect('/admin');
});

module.exports = router;
