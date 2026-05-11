/**
 * Auth middleware: requireAuth, requireManager, requireAdmin, loadCurrentUser, setFlash.
 *
 * Roles:
 *   admin   — full access
 *   manager — same as admin for v0.5 (can create/edit/send everything)
 *   worker  — limited: WO list (own + assigned), edit WO, notes/photos. NEVER prices.
 *
 * Money-blind workers: routes that expose pricing or estimates/invoices use
 * requireManager. The dashboard, customer/job CRUD, estimate/invoice CRUD,
 * admin pages all sit behind requireManager. Workers only see /work-orders
 * and a worker-specific dashboard (Round 4 work).
 */

const db = require('../db/db');

const asyncHandler = require('./async-handler');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  next();
}

function requireManager(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  if (!['admin', 'manager'].includes(req.session.role)) {
    return res.status(403).render('error', {
      title: 'Forbidden', code: 403,
      message: 'Manager or admin access required.'
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  if (req.session.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Forbidden', code: 403,
      message: 'Admin access required.'
    });
  }
  next();
}

const loadCurrentUser = asyncHandler(async (req, res, next) => {
  res.locals.currentUser = null;
  res.locals.flash = (req.session && req.session.flash) || {};
  if (req.session) delete req.session.flash;

  if (req.session && req.session.userId) {
    const user = await db.get(
      'SELECT id, email, name, role FROM users WHERE id = ? AND active = 1',
      [req.session.userId]
    );
    if (user) {
      res.locals.currentUser = user;
      res.locals.canSeePrices = ['admin', 'manager'].includes(user.role);
      res.locals.isWorker = user.role === 'worker';
    } else {
      if (req.session) req.session.destroy(() => {});
    }
  }
  next();
});

function setFlash(req, kind, message) {
  if (!req.session) return;
  req.session.flash = req.session.flash || {};
  req.session.flash[kind] = message;
}

module.exports = { requireAuth, requireManager, requireAdmin, loadCurrentUser, setFlash };
