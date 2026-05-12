/**
 * app.js — Express app factory. Builds and returns the configured Express app.
 * Used by server.js (local dev) and Vercel (production).
 *
 * The app is built synchronously at module level. DB init happens lazily
 * on first request via the `ensureDbInit` middleware.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config();
require('express-async-errors');
/* eslint-env node */
if (!process.env.TZ) process.env.TZ = 'America/New_York';

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const morgan = require('morgan');

const { loadCurrentUser, requireAuth, requireManager, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const customersRoutes = require('./routes/customers');
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
const settingsRoutes = require('./routes/settings');
const signupRoutes = require('./routes/signup');

// F2: rate limiters for auth endpoints to slow credential stuffing,
// account enumeration, and password reset spam.
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts from this IP. Try again in 15 minutes.',
  skip: (req) => req.method !== 'POST',
});
const lowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP. Try again in 15 minutes.',
  skip: (req) => req.method !== 'POST',
});

const PORT = parseInt(process.env.PORT, 10) || 3001;
// F6: No fallback. SESSION_SECRET MUST be set at boot in every environment.
// Without a secret, session cookies cannot be signed safely, so we fail-fast
// rather than silently accept a known/default value that an attacker could use
// to forge sessions.
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  throw new Error('FATAL: SESSION_SECRET must be set to a strong (>=16 chars) random value before boot.');
}
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSIONS_DIR = process.env.NODE_ENV === 'production'
  ? '/tmp/forge-sessions'
  : path.join(__dirname, '..', 'sessions');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, 'views');

let dbReady = false;

async function ensureDbInit(req, res, next) {
  if (!dbReady) {
    const db = require('./db/db');
    await db.init();
    try { await db.run(`CREATE TABLE IF NOT EXISTS pending_confirmations ( id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' )`); } catch(e) {}
    try { await db.run(`CREATE TABLE IF NOT EXISTS closures ( id INTEGER PRIMARY KEY, date_start TEXT NOT NULL, date_end TEXT, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'holiday', notes TEXT, created_by_user_id INTEGER, created_at TEXT NOT NULL DEFAULT (now()) )`); } catch(e) {}
    try { await db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens ( id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now() )`); } catch(e) {}
    try { await db.run(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)`); } catch(e) {}
    if (db.getMode() !== 'pg') {
      // password_reset_tokens for sqlite mode
      try { await db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (now()) )`); } catch(e) {}
      try { await db.run(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)`); } catch(e) {}
      try {
        const bootMigrations = [
          {table:'users',col:'phone',type:'TEXT'},{table:'users',col:'mock',type:'INTEGER NOT NULL DEFAULT 0'},
          {table:'work_order_line_items',col:'completed_at',type:'TEXT'},{table:'work_orders',col:'scheduled_end_time',type:'TEXT'},
          {table:'estimates',col:'sent_by_user_id',type:'INTEGER'},{table:'estimates',col:'sent_to_email',type:'TEXT'},
          {table:'estimates',col:'sent_to_name',type:'TEXT'},{table:'invoices',col:'sent_by_user_id',type:'INTEGER'},
          {table:'invoices',col:'sent_to_email',type:'TEXT'},{table:'invoices',col:'sent_to_name',type:'TEXT'},
          {table:'estimates',col:'archived_at',type:'TEXT'},{table:'estimates',col:'payment_terms',type:"TEXT NOT NULL DEFAULT 'Net 30'"},
        ];
        for (const m of bootMigrations) {
          const existing = await db.all('PRAGMA table_info(' + m.table + ')');
          if (!existing.find(c => c.name === m.col)) { await db.run('ALTER TABLE ' + m.table + ' ADD COLUMN ' + m.col + ' ' + m.type); }
        }
      } catch(e) { console.error('Boot migration failed:', e.message); }
    }
    dbReady = true;
    console.log('[app] db initialized');
  }
  next();
}

const app = express();

// Trust the first proxy hop (Vercel terminates TLS at the edge and forwards HTTP to the Lambda).
// REQUIRED for cookie-session with `secure: true` — without this, Express reads req.protocol as
// 'http' and cookie-session refuses to emit the cookie, breaking login + session entirely.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

// Session store — cookie-based on Vercel (no server-side storage needed for serverless),
// FileStore locally
let sessionMiddleware;
app.use(async (req, res, next) => {
  if (!sessionMiddleware) {
    if (process.env.NODE_ENV === 'production') {
      // Vercel Lambda: cookie-session (signed cookie, no server-side state)
      const cookieSession = require('cookie-session');
      sessionMiddleware = cookieSession({
        name: 'forge_sid',
        secret: SESSION_SECRET,
        maxAge: 8 * 3600 * 1000, // 8 hours
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        overwrite: true
      });
    } else {
      await ensureDbInit(req, res, () => {});
      const FileStore = require('session-file-store')(session);
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      sessionMiddleware = session({
        store: new FileStore({ path: SESSIONS_DIR, retries: 1, logFn: () => {} }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 }
      });
    }
  }
  sessionMiddleware(req, res, next);
});

app.use(loadCurrentUser);
app.get('/ping', (req, res) => { res.json({ ok: true, ts: new Date().toISOString() }); });

// Health / version endpoint — public, returns deploy info for agent handoffs
app.get('/health/version', async (req, res) => {
  let sha = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown';
  const buildTime = null;
  // Remove git exec — not available on Vercel Lambda or build env
  res.json({
    app: 'forge',
    version: sha,
    build_time: buildTime,
    deployed: new Date().toISOString(),
    node: process.version,
    env: process.env.NODE_ENV || 'production',
    vercel_url: process.env.VERCEL_URL || null,
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
  });
});

// F2: apply rate limiters BEFORE the auth/signup routers see the request.
// 5/15min on login + signup; 3/15min on forgot-password + resend-verification +
// reset-password POST. Only POST is rate-limited so GET pages still render.
app.use('/login', authLimiter);
app.use('/signup', authLimiter);
app.use('/forgot-password', lowLimiter);
app.use('/resend-verification', lowLimiter);
app.use('/reset-password', lowLimiter);

app.use('/', authRoutes);
app.use('/', signupRoutes);
app.use('/customers', requireAuth, requireManager, customersRoutes);
app.use('/jobs', requireAuth, requireManager, (req, res) => res.redirect('/work-orders'));
app.use('/estimates', requireAuth, requireManager, estimatesRoutes);
app.use('/invoices', requireAuth, requireManager, invoicesRoutes);
app.use('/bills', requireAuth, requireManager, billsRoutes);
app.use('/admin', requireAuth, requireAdmin, adminRoutes);
app.use('/admin/closures', requireAuth, requireAdmin, closuresRoutes);
app.use('/settings', requireAuth, settingsRoutes);
app.use('/work-orders', requireAuth, workOrdersRoutes);
app.use('/schedule', requireAuth, scheduleRoutes);
app.use('/accounting', requireAuth, requireManager, accountingRoutes);
app.use('/vendors', requireAuth, requireManager, vendorsRoutes);
app.get('/ai/chat/health', (req, res) => { const enabled = process.env.AI_CHAT_ENABLED === undefined || process.env.AI_CHAT_ENABLED === '' || process.env.AI_CHAT_ENABLED === '1' || process.env.AI_CHAT_ENABLED === 'true'; res.json({ enabled, model: 'deepseek-chat', provider: process.env.AI_PROVIDER || 'deepseek' }); });
app.use('/ai', requireAuth, aiChatRoutes);
app.use('/files', requireAuth, filesRoutes);
app.use('/', requireAuth, dashboardRoutes);

app.use((req, res) => { res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.' }); });
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const title = safeStatus === 500 ? 'Server error' : 'Bad request';
  const message = err.message && err.message.length < 200
    ? (safeStatus === 500 ? 'Server error' : 'Bad request')
    : 'Something went wrong.';
  res.status(safeStatus).render('error', { title, code: safeStatus, message, currentUrl: req.originalUrl });
});

// POST /report-error — user-triggered error report email
app.post('/report-error', async (req, res) => {
  const { code, message, url, user_email } = req.body;
  const subject = `[FORGE Error Report] ${code} on ${url || 'unknown page'}`;
  const body = `Error report from FORGE\n\nCode: ${code}\nURL: ${url || 'unknown'}\nUser: ${user_email || 'unknown'}\nMessage: ${message || 'none'}\nTimestamp: ${new Date().toISOString()}`;
  try {
    const emailService = require('./services/email');
    await emailService.sendEmail({
      to: 'mike@reconenterprises.net',
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });
    res.redirect(url || '/');
  } catch (e) {
    console.error('[report-error] send failed:', e.message);
    res.redirect(url || '/');
  }
});

module.exports = app;
