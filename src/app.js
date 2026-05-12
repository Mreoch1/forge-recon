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
const jobsRoutes = require('./routes/jobs');
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
const settingsRoutes = require('./routes/settings');
const signupRoutes = require('./routes/signup');

// F2: rate limiters for auth endpoints to slow credential stuffing,
// account enumeration, and password reset spam.
const rateLimit = require('express-rate-limit');
// R37o: bumped limits because office IPs serve multiple users behind NAT — the
// original 5/15min per-IP was eating real-user budgets (e.g. Chris locked out
// after a forgot-password + retry combo). Per-user keying would be ideal but
// requires reading req.body.email which the limiter middleware runs BEFORE the
// body parser by default. Quick fix: more generous IP-wide limits.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts from this IP. Try again in 15 minutes.',
  skip: (req) => req.method !== 'POST',
});
const lowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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
// D-007: Projects layer — Jobs renamed Projects in UI. /projects is canonical;
// /jobs preserved as a redirect so older links keep working.
app.use('/projects', requireAuth, requireManager, jobsRoutes);
app.use('/jobs', requireAuth, requireManager, (req, res) => {
  const tail = req.url === '/' ? '' : req.url;
  res.redirect(302, '/projects' + tail);
});
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
app.get('/ai/chat/health', (req, res) => {
  const ai = require('./services/ai');
  const enabled = process.env.AI_CHAT_ENABLED === undefined
    || process.env.AI_CHAT_ENABLED === ''
    || process.env.AI_CHAT_ENABLED === '1'
    || process.env.AI_CHAT_ENABLED === 'true';
  res.json({
    enabled,
    model: ai.modelName(ai.provider()) || 'deepseek-chat',
    provider: ai.provider(),
    configured_providers: ai.configuredProviders ? ai.configuredProviders() : [],
  });
});
app.use('/ai', requireAuth, aiChatRoutes);
app.use('/', requireAuth, dashboardRoutes);

// POST /report-error — user-triggered error report email (must be before 404 handler)
app.post('/report-error', async (req, res) => {
  const { code, message, url, user_email, error_detail, error_ctx } = req.body;
  let ctx = {};
  try { if (error_ctx) ctx = JSON.parse(error_ctx); } catch(e) {}
  const subject = `[FORGE Error] ${url || 'unknown page'}`;
  const bodyHtml = `
    <div style="max-width:600px;margin:0 auto;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
    <div style="background:linear-gradient(135deg,#c0202b 0%,#8a0e16 50%,#5a5a5a 100%);padding:24px 32px;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700;letter-spacing:-.02em">FORGE Error Report</h1>
      <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">A user encountered a server error</p>
    </div>
    <div style="background:#fff;border:1px solid #e0e0e0;border-top:0;padding:24px 32px;border-radius:0 0 12px 12px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="color:#888;padding:8px;border:1px solid #eee;font-weight:600;width:100px">Status</td><td style="color:#c0202b;padding:8px;border:1px solid #eee;font-weight:600">${code}</td></tr>
        <tr><td style="color:#888;padding:8px;border:1px solid #eee;font-weight:600">URL</td><td style="color:#333;padding:8px;border:1px solid #eee">${url || 'unknown'}</td></tr>
        <tr><td style="color:#888;padding:8px;border:1px solid #eee;font-weight:600">Method</td><td style="color:#333;padding:8px;border:1px solid #eee">${ctx.method || 'unknown'}</td></tr>
        <tr><td style="color:#888;padding:8px;border:1px solid #eee;font-weight:600">User</td><td style="color:#333;padding:8px;border:1px solid #eee">${ctx.user || user_email || 'unknown'}</td></tr>
        <tr><td style="color:#888;padding:8px;border:1px solid #eee;font-weight:600">Time</td><td style="color:#333;padding:8px;border:1px solid #eee">${ctx.timestamp || new Date().toISOString()}</td></tr>
      </table>
      <div style="background:#fff0f0;border-radius:8px;padding:16px;margin:16px 0;border:1px solid #fcc">
        <p style="font-size:12px;color:#888;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em">Error detail</p>
        <p style="font-size:13px;color:#333;margin:0;font-family:monospace;white-space:pre-wrap">${error_detail || message || 'none'}</p>
      </div>
      <div style="text-align:center;margin:16px 0">
        <a href="${process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app'}${url || '/'}" style="display:inline-block;background:#c0202b;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Open in FORGE</a>
      </div>
    </div>
    </div>`;
  try {
    const emailService = require('./services/email');
    await emailService.sendEmail({
      to: 'support@reconenterprises.net',
      subject,
      htmlBody: bodyHtml,
      text: `FORGE Error Report\n\nStatus: ${code}\nURL: ${url || 'unknown'}\nUser: ${ctx.user || user_email || 'unknown'}\nMethod: ${ctx.method || 'unknown'}\nTime: ${ctx.timestamp || 'unknown'}\n\nError: ${error_detail || message || 'none'}`,
    });
    res.redirect(url || '/');
  } catch (e) {
    console.error('[report-error] send failed:', e.message);
    res.redirect(url || '/');
  }
});

// POST /feedback — support/feedback from the floating button
app.post('/feedback', async (req, res) => {
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  if (!subject || !message) {
    setFlash(req, 'error', 'Subject and message are required.');
    return res.redirect(req.headers.referer || '/');
  }
  const userEmail = req.currentUser?.email || req.session?.email || 'unknown';
  const name = req.currentUser?.name || '';
  const html = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#c0202b,#8a0e16);padding:24px;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:20px">FORGE Feedback</h1>
    </div>
    <div style="background:#fff;border:1px solid #e0e0e0;padding:24px;border-radius:0 0 12px 12px">
      <p style="font-size:14px;color:#555"><strong>From:</strong> ${name} &lt;${userEmail}&gt;</p>
      <p style="font-size:14px;color:#555"><strong>Page:</strong> ${req.headers.referer || '—'}</p>
      <p style="font-size:14px;color:#555"><strong>User-Agent:</strong> ${req.headers['user-agent'] || '—'}</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
        <p style="font-size:13px;color:#888;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em">${subject}</p>
        <p style="font-size:14px;color:#333;margin:0;white-space:pre-line">${message}</p>
      </div>
    </div>`;

  try {
    const emailService = require('./services/email');
    await emailService.sendEmail({
      to: 'support@reconenterprises.net',
      subject: `[FORGE Feedback] ${subject}`,
      html,
    });
    await supabase.from('audit_logs').insert({
      entity_type: 'feedback', action: 'submitted', source: 'user',
      details: { subject, user: userEmail }, user_id: req.session.userId || null,
    }).then().catch(() => {});
    setFlash(req, 'success', 'Thanks for the feedback! Mike will review it.');
  } catch (e) {
    console.error('[feedback] send failed:', e.message);
    setFlash(req, 'error', 'Could not send feedback. Try again later.');
  }
  res.redirect(req.headers.referer || '/');
});

// POST /account/ack-email-warning — dismiss the email warning modal (D-029)
app.post('/account/ack-email-warning', async (req, res) => {
  if (!req.session.userId) return res.status(401).redirect('/login');
  try {
    const supabase = require('./db/supabase');
    await supabase.from('users').update({ acknowledged_live_email_warning_at: new Date() }).eq('id', req.session.userId);
  } catch (e) {
    console.warn('[account] ack-email-warning failed:', e.message);
  }
  res.redirect(req.headers.referer || '/');
});

// GET /onboarding — first-login intro page (D-030)
app.get('/onboarding', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.render('onboarding', { title: 'Welcome to FORGE', activeNav: '' });
});

// POST /account/complete-onboarding — dismiss onboarding (D-030)
app.post('/account/complete-onboarding', async (req, res) => {
  if (!req.session.userId) return res.status(401).redirect('/login');
  try {
    const supabase = require('./db/supabase');
    await supabase.from('users').update({ completed_onboarding_at: new Date() }).eq('id', req.session.userId);
    // Reload session user
    const { data: user } = await supabase.from('users').select('id, name, email, role, active, acknowledged_live_email_warning_at, completed_onboarding_at').eq('id', req.session.userId).maybeSingle();
    if (user) req.currentUser = user;
  } catch (e) {
    console.warn('[account] complete-onboarding failed:', e.message);
  }
  res.redirect('/');
});

app.use((req, res) => {
  const errorCtx = { method: req.method, user: req.currentUser?.email || req.session?.email || 'unknown', timestamp: new Date().toISOString() };
  res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.', currentUrl: req.originalUrl, errorCtx });
});
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const title = safeStatus === 500 ? 'Server error' : 'Bad request';
  const safeMsg = title;
  // Store real error detail for the report-error button
  const errorDetail = err && err.message ? err.message.slice(0, 500) : '';
  const errorCtx = {
    method: req.method,
    body: process.env.NODE_ENV === 'production' ? '(hidden)' : JSON.stringify(req.body).slice(0, 500),
    query: JSON.stringify(req.query).slice(0, 200),
    user: req.currentUser?.email || req.session?.email || 'unknown',
    userId: req.currentUser?.id || req.session?.userId || null,
    timestamp: new Date().toISOString(),
  };
  res.status(safeStatus).render('error', { title, code: safeStatus, message: safeMsg, currentUrl: req.originalUrl, errorDetail, errorCtx });
});

module.exports = app;
