/**
 * Recon Construction Work Order — main server entry.
 *
 *   PORT       (env, default 3001)  — HTTP listener port (3000 was in use)
 *   SESSION_SECRET (env, default 'dev-secret-change-me')
 *
 * On boot:
 *   1. Initialize sql.js DB (loads from data/app.db if present).
 *   2. Mount middleware: helmet, morgan, body parsers, static, sessions, EJS.
 *   3. Mount routes: auth (public), then dashboard + future feature routes (auth-gated).
 *   4. 404 + 500 handlers render error.ejs.
 *
 * Public routes:  GET /login, POST /login, POST /logout, GET /ping
 * Gated routes:   GET /  (dashboard) — more added in subsequent phases.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const morgan = require('morgan');

const db = require('./db/db');
const { loadCurrentUser, requireAuth, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const customersRoutes = require('./routes/customers');
const jobsRoutes = require('./routes/jobs');
const estimatesRoutes = require('./routes/estimates');
const workOrdersRoutes = require('./routes/work-orders');
const invoicesRoutes = require('./routes/invoices');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

async function main() {
  await db.init();

  const app = express();

  // EJS
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);

  // Security + logging. CSP off in v0 because we use CDN tailwind/htmx.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('dev'));

  // Body parsers
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Static
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

  // Sessions (file-backed, stored under sessions/)
  app.use(session({
    store: new FileStore({
      path: SESSIONS_DIR,
      retries: 1,
      logFn: () => {} // suppress file-store chatter
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,  // 8h
      httpOnly: true,
      sameSite: 'lax'
    }
  }));

  // Make currentUser + flash available to every view
  app.use(loadCurrentUser);

  // Health (no auth)
  app.get('/ping', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Auth routes (public)
  app.use('/', authRoutes);

  // Feature routes (all gated)
  app.use('/customers', requireAuth, customersRoutes);
  app.use('/jobs', requireAuth, jobsRoutes);
  app.use('/estimates', requireAuth, estimatesRoutes);
  app.use('/work-orders', requireAuth, workOrdersRoutes);
  app.use('/invoices', requireAuth, invoicesRoutes);
  app.use('/admin', requireAuth, requireAdmin, adminRoutes);

  // Dashboard (gated)
  app.use('/', requireAuth, dashboardRoutes);

  // 404
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Not found',
      code: 404,
      message: 'That page does not exist.'
    });
  });

  // 500
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', {
      title: 'Server error',
      code: 500,
      message: process.env.NODE_ENV === 'production'
        ? 'Something broke on our end.'
        : (err.message || 'Server error')
    });
  });

  app.listen(PORT, () => {
    console.log(`Recon WO server listening on http://localhost:${PORT}`);
    console.log(`Node ${process.version}  pid ${process.pid}  env ${process.env.NODE_ENV || 'dev'}`);
  });
}

main().catch(err => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
