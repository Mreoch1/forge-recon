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
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const morgan = require('morgan');

const db = require('./db/db');
const { loadCurrentUser, requireAuth, requireManager, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const customersRoutes = require('./routes/customers');
const jobsRoutes = require('./routes/jobs');
const estimatesRoutes = require('./routes/estimates');
const workOrdersRoutes = require('./routes/work-orders');
const invoicesRoutes = require('./routes/invoices');
const scheduleRoutes = require('./routes/schedule');
const billsRoutes = require('./routes/bills');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');
const accountingRoutes = require('./routes/accounting');
const vendorsRoutes = require('./routes/vendors');
const aiChatRoutes = require('./routes/ai-chat');
const closuresRoutes = require('./routes/closures');
const filesRoutes = require('./routes/files');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

// Production safety checks
if (process.env.NODE_ENV === 'production') {
  if (!SESSION_SECRET || SESSION_SECRET === 'dev-secret-change-me') {
    console.error('FATAL: SESSION_SECRET must be set in production. Set a strong random value in .env');
    process.exit(1);
  }
  if (process.env.AI_PROVIDER && (!process.env.AI_API_KEY || process.env.AI_API_KEY === '' || process.env.AI_API_KEY.startsWith('sk-placeholder'))) {
    console.warn('WARNING: AI_PROVIDER is set but AI_API_KEY is empty or placeholder. AI features disabled.');
  }
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

async function main() {
  await db.init();

  // Ensure pending_confirmations table exists
  try {
    db.run(`CREATE TABLE IF NOT EXISTS pending_confirmations (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    )`);
  } catch(e) { console.error("Failed to create pending_confirmations table:", e.message); }

  // Ensure closures table exists
  try {
    db.run(`CREATE TABLE IF NOT EXISTS closures (
      id INTEGER PRIMARY KEY,
      date_start TEXT NOT NULL,
      date_end TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'holiday',
      notes TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (now())
    )`);
  } catch(e) { console.error("Failed to create closures table:", e.message); }

  // Column migrations for existing databases
  try {
    const bootMigrations = [
      {table: 'users', col: 'phone', type: 'TEXT'},
      {table: 'users', col: 'mock', type: 'INTEGER NOT NULL DEFAULT 0'},
      {table: 'work_order_line_items', col: 'completed_at', type: 'TEXT'},
      {table: 'work_orders', col: 'scheduled_end_time', type: 'TEXT'},
      {table: 'estimates', col: 'sent_by_user_id', type: 'INTEGER'},
      {table: 'estimates', col: 'sent_to_email', type: 'TEXT'},
      {table: 'estimates', col: 'sent_to_name', type: 'TEXT'},
      {table: 'invoices', col: 'sent_by_user_id', type: 'INTEGER'},
      {table: 'invoices', col: 'sent_to_email', type: 'TEXT'},
      {table: 'invoices', col: 'sent_to_name', type: 'TEXT'},
      {table: 'estimates', col: 'archived_at', type: 'TEXT'},
    ];
    bootMigrations.forEach(m => {
      const existing = db.all('PRAGMA table_info(' + m.table + ')');
      if (!existing.find(c => c.name === m.col)) {
        db.run('ALTER TABLE ' + m.table + ' ADD COLUMN ' + m.col + ' ' + m.type);
        console.log('  Boot migration: added ' + m.table + '.' + m.col);
      }
    });
  } catch(e) { console.error('Boot migration failed:', e.message); }

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

  // Sessions — pg-backed when DATABASE_URL is set, file-backed for local sqlite dev
  let sessionStore;
  if (db.getMode() === 'pg') {
    const pgSession = require('connect-pg-simple')(session);
    sessionStore = new pgSession({
      pool: db.getPool(),
      tableName: 'session',
      createTableIfMissing: true,
    });
  } else {
    const FileStore = require('session-file-store')(session);
    sessionStore = new FileStore({
      path: SESSIONS_DIR,
      retries: 1,
      logFn: () => {}
    });
  }
  app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,  // 8h
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

  // Feature routes
  // Pricing/financial routes are manager+admin only (workers can't see prices)
  app.use('/customers', requireAuth, requireManager, customersRoutes);
  app.use('/jobs', requireAuth, requireManager, jobsRoutes);
  app.use('/estimates', requireAuth, requireManager, estimatesRoutes);
  app.use('/invoices', requireAuth, requireManager, invoicesRoutes);
  app.use('/bills', requireAuth, requireManager, billsRoutes);
  app.use('/admin', requireAuth, requireAdmin, adminRoutes);
  app.use('/admin/closures', requireAuth, requireAdmin, closuresRoutes);
  // Work orders are worker-accessible (Round 4 will scope to assigned WOs only)
  app.use('/work-orders', requireAuth, workOrdersRoutes);
  app.use('/schedule', requireAuth, scheduleRoutes);
  app.use('/accounting', requireAuth, requireManager, accountingRoutes);
  app.use('/vendors', requireAuth, requireManager, vendorsRoutes);
  // Public AI health check (no auth needed — must be before the gated /ai mount)
  app.get('/ai/chat/health', (req, res) => {
    const enabled = process.env.AI_CHAT_ENABLED === undefined || process.env.AI_CHAT_ENABLED === '' || process.env.AI_CHAT_ENABLED === '1' || process.env.AI_CHAT_ENABLED === 'true';
    res.json({ enabled, model: 'deepseek-chat', provider: process.env.AI_PROVIDER || 'deepseek' });
  });
  app.use('/ai', requireAuth, aiChatRoutes);
  app.use('/files', requireAuth, filesRoutes);

  // Dashboard — v2 redesign (classic at /dashboard-classic)
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
    console.log(`FORGE server listening on http://localhost:${PORT}`);
    console.log(`Node ${process.version}  pid ${process.pid}  env ${process.env.NODE_ENV || 'dev'}`);
  });
}

main().catch(err => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
