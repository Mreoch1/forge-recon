/**
 * Auth middleware: requireAuth, requireAdmin, loadCurrentUser.
 *
 * Sessions store userId + role. loadCurrentUser populates res.locals.currentUser
 * from the DB on every request so views always have a fresh user object.
 *
 * Flash messages: stored in req.session.flash, consumed once per request.
 */

const db = require('../db/db');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  if (req.session.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Forbidden',
      code: 403,
      message: 'Admin access required.'
    });
  }
  next();
}

function loadCurrentUser(req, res, next) {
  res.locals.currentUser = null;
  res.locals.flash = (req.session && req.session.flash) || {};
  if (req.session) delete req.session.flash;

  if (req.session && req.session.userId) {
    const user = db.get(
      'SELECT id, email, name, role FROM users WHERE id = ? AND active = 1',
      [req.session.userId]
    );
    if (user) {
      res.locals.currentUser = user;
    } else {
      // User got deactivated mid-session — kill the session.
      if (req.session) req.session.destroy(() => {});
    }
  }
  next();
}

function setFlash(req, kind, message) {
  if (!req.session) return;
  req.session.flash = req.session.flash || {};
  req.session.flash[kind] = message;
}

module.exports = { requireAuth, requireAdmin, loadCurrentUser, setFlash };
