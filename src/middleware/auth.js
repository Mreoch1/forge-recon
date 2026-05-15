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

const supabase = require('../db/supabase');

const asyncHandler = require('./async-handler');

// Hard-coded owner email — always treated as admin regardless of DB role value.
// Belt-and-suspenders so the owner can never accidentally lose admin via a
// stale role column, bad migration, or a reset password→worker race.
const OWNER_EMAILS = (process.env.OWNER_EMAILS || 'mike@reconenterprises.net')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isOwnerEmail(email) {
  return !!email && OWNER_EMAILS.includes(String(email).toLowerCase());
}

function clearSession(req, done = () => {}) {
  if (!req.session) {
    done();
    return;
  }

  if (typeof req.session.destroy === 'function') {
    req.session.destroy((err) => {
      if (err) console.error('session destroy failed (continuing):', err.message);
      done();
    });
    return;
  }

  req.session = null;
  done();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  // D-030: redirect users who haven't completed onboarding
  if (req.path !== '/onboarding' && !req.session.completed_onboarding_at && res.locals.currentUser && !res.locals.currentUser.completed_onboarding_at) {
    return res.redirect('/onboarding');
  }
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
  res.locals.announcement = null;
  if (req.session) delete req.session.flash;

  // D-090: Load the active banner inside the request so views can reliably render it.
  try {
    const announcements = require('../services/announcements');
    res.locals.announcement = await announcements.getActiveAnnouncement();
  } catch(e) { /* announcement service not available */ }

  if (req.session && req.session.userId) {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, role, default_landing, acknowledged_live_email_warning_at, completed_onboarding_at')
      .eq('id', req.session.userId)
      .eq('active', 1)
      .maybeSingle();
    if (error) throw error;
    if (user) {
      // Owner override — never let the owner email render as anything but admin.
      // Force session role every request regardless of DB value, so a stale
      // cookie from before a role change or signup doesn't persist.
      if (isOwnerEmail(user.email)) {
        user.role = 'admin';
        if (req.session) req.session.role = 'admin';
      }
      res.locals.currentUser = user;
      res.locals.canSeePrices = ['admin', 'manager'].includes(user.role);
      res.locals.isWorker = user.role === 'worker';
      // D-081: detect FORGE route for minimal header
      res.locals.isForgeRoute = /^\/forge/.test(req.path);
      // D-073: show back button on detail/edit pages (not index pages)
      const _detailMatch = req.path.match(/^\/(work-orders|customers|vendors|projects|estimates|invoices|bills|schedule)\/\d+/);
      res.locals.showBackButton = !!_detailMatch || /\/edit$/.test(req.path);
      // Sensible fallback if no browser history: the entity's index page
      if (_detailMatch) {
        const _fallbacks = { 'work-orders':'/work-orders', 'customers':'/customers', 'vendors':'/vendors', 'projects':'/projects', 'estimates':'/estimates', 'invoices':'/invoices', 'bills':'/bills', 'schedule':'/schedule' };
        res.locals.backButtonFallback = _fallbacks[_detailMatch[1]] || '/';
      } else {
        res.locals.backButtonFallback = '/';
      }
    } else {
      clearSession(req);
    }
  }
  next();
});

/** Load active announcement into res.locals for every request */
async function loadAnnouncement(req, res, next) {
  try {
    const announcements = require('../services/announcements');
    res.locals.announcement = await announcements.getActiveAnnouncement();
  } catch(e) { /* announcement service not available */ }
  next();
}

function setFlash(req, kind, message) {
  if (!req.session) return;
  req.session.flash = req.session.flash || {};
  req.session.flash[kind] = message;
}

module.exports = { requireAuth, requireManager, requireAdmin, loadCurrentUser, setFlash, clearSession, loadAnnouncement, isOwnerEmail, OWNER_EMAILS };
