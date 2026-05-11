/**
 * closures.js — Admin CRUD for closures/holidays.
 * Mounted at /admin/closures under requireAuth + requireAdmin.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');

router.get('/', (req, res) => {
  const closures = db.all('SELECT * FROM closures ORDER BY date_start ASC');
  res.render('admin/closures/index', { title: 'Closures', activeNav: 'admin', closures });
});

router.get('/new', (req, res) => {
  res.render('admin/closures/new', {
    title: 'New closure', activeNav: 'admin',
    closure: { date_start: '', date_end: '', name: '', type: 'holiday', notes: '' },
    errors: {},
  });
});

router.post('/', (req, res) => {
  const errors = {};
  const date_start = (req.body.date_start || '').trim();
  const name = (req.body.name || '').trim();
  const type = req.body.type || 'holiday';
  if (!date_start) errors.date_start = 'Start date required.';
  if (!name) errors.name = 'Name required.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/closures/new', {
      title: 'New closure', activeNav: 'admin',
      closure: { date_start, date_end: req.body.date_end || '', name, type, notes: req.body.notes || '' },
      errors,
    });
  }
  db.run(`INSERT INTO closures (date_start, date_end, name, type, notes, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [date_start, req.body.date_end || null, name, type, req.body.notes || null, req.session.userId]);
  setFlash(req, 'success', `Closure "${name}" created.`);
  res.redirect('/admin/closures');
});

router.get('/:id/edit', (req, res) => {
  const closure = db.get('SELECT * FROM closures WHERE id = ?', [req.params.id]);
  if (!closure) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Closure not found.' });
  res.render('admin/closures/edit', {
    title: `Edit ${closure.name}`, activeNav: 'admin',
    closure, errors: {},
  });
});

router.post('/:id', (req, res) => {
  const closure = db.get('SELECT * FROM closures WHERE id = ?', [req.params.id]);
  if (!closure) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Closure not found.' });
  const errors = {};
  const date_start = (req.body.date_start || '').trim();
  const name = (req.body.name || '').trim();
  const type = req.body.type || 'holiday';
  if (!date_start) errors.date_start = 'Start date required.';
  if (!name) errors.name = 'Name required.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/closures/edit', {
      title: `Edit ${closure.name}`, activeNav: 'admin',
      closure: { ...closure, date_start, date_end: req.body.date_end || null, name, type, notes: req.body.notes || '' },
      errors,
    });
  }
  db.run(`UPDATE closures SET date_start=?, date_end=?, name=?, type=?, notes=? WHERE id=?`,
    [date_start, req.body.date_end || null, name, type, req.body.notes || null, closure.id]);
  setFlash(req, 'success', `Closure "${name}" updated.`);
  res.redirect('/admin/closures');
});

router.post('/:id/delete', (req, res) => {
  const closure = db.get('SELECT * FROM closures WHERE id = ?', [req.params.id]);
  if (!closure) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Closure not found.' });
  db.run('DELETE FROM closures WHERE id = ?', [closure.id]);
  setFlash(req, 'success', `Closure "${closure.name}" deleted.`);
  res.redirect('/admin/closures');
});

module.exports = router;
