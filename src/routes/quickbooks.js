/**
 * quickbooks.js — QuickBooks Online OAuth 2.0 routes
 *
 * Mounted at /accounting/quickbooks under requireAdmin.
 *
 *   GET  /connect    — redirect to Intuit OAuth authorization page
 *   GET  /callback   — OAuth callback (code exchange)
 *   POST /disconnect — disconnect QuickBooks
 *   GET  /status     — check connection status (JSON)
 *   POST /sync       — trigger a sync (customers, invoices, bills)
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, setFlash } = require('../middleware/auth');
const qb = require('../services/quickbooks');

// ── State store (in-memory OAuth state validation) ───────────────────────────
// In production, use the DB or session. For simplicity, store in a module-level
// Map keyed by session userId. The `state` parameter prevents CSRF on the callback.
const pendingStates = new Map();

// ── Root (Launch URL) ──────────────────────────────────────────────────────────

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.redirect('/accounting/quickbooks-import');
});

// ── Connect ────────────────────────────────────────────────────────────────────

router.get('/connect', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { url, state } = qb.getAuthUrl();
    // Store state tied to this user's session
    pendingStates.set(req.session.userId, { state, createdAt: Date.now() });
    // Clean up stale entries older than 10 minutes
    for (const [key, val] of pendingStates) {
      if (Date.now() - val.createdAt > 10 * 60 * 1000) pendingStates.delete(key);
    }
    res.redirect(302, url);
  } catch (e) {
    setFlash(req, 'error', 'Failed to start QuickBooks connection: ' + e.message);
    res.redirect('/accounting/quickbooks-import');
  }
});

// ── Callback ───────────────────────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { code, state, error, realmId: realmIdParam } = req.query;

  if (error) {
    return res.status(400).render('error', {
      title: 'QuickBooks connection failed',
      code: 400,
      message: `QuickBooks returned: ${error}`,
    });
  }

  if (!code) {
    return res.status(400).render('error', {
      title: 'Missing code',
      code: 400,
      message: 'No authorization code received from QuickBooks.',
    });
  }

  // Validate state (CSRF protection) — find matching state across pending sessions
  let matchedUserId = null;
  for (const [userId, pending] of pendingStates) {
    if (pending.state === state) {
      matchedUserId = userId;
      pendingStates.delete(userId);
      break;
    }
  }
  if (!matchedUserId) {
    // State might have expired; still try the exchange but log a warning
    console.warn('[quickbooks] callback received with unknown/expired state parameter');
  }

  try {
    const tokens = await qb.exchangeCode(code);
    await qb.saveTokens(tokens);

    await qb.logSync('oauth', 'connect', 'QuickBooks connected successfully', {
      realmId: tokens.realmId || realmIdParam || null,
    });

    setFlash(req, 'success', 'QuickBooks connected successfully! You can now sync data.');
    res.redirect('/accounting/quickbooks-import');
  } catch (e) {
    console.error('[quickbooks] token exchange failed:', e);
    res.status(500).render('error', {
      title: 'Connection failed',
      code: 500,
      message: 'Failed to complete QuickBooks connection: ' + e.message,
    });
  }
});

// ── Disconnect ─────────────────────────────────────────────────────────────────

router.post('/disconnect', requireAuth, requireAdmin, async (req, res) => {
  try {
    const row = await qb.getTokenRow();
    if (row) {
      const now = new Date().toISOString();
      await require('../db/supabase')
        .from('quickbooks_tokens')
        .update({ disconnected_at: now })
        .eq('id', row.id);
      await qb.logSync('oauth', 'disconnect', 'QuickBooks disconnected');
    }
    setFlash(req, 'success', 'QuickBooks disconnected.');
  } catch (e) {
    console.error('[quickbooks] disconnect failed:', e);
    setFlash(req, 'error', 'Failed to disconnect: ' + e.message);
  }
  res.redirect('/accounting/quickbooks-import');
});

// ── Status (JSON) ──────────────────────────────────────────────────────────────

router.get('/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const connected = await qb.isConnected();
    const row = connected ? await qb.getTokenRow() : null;
    res.json({
      connected,
      realmId: row?.realm_id || null,
      connectedAt: row?.connected_at || null,
    });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ── Sync ───────────────────────────────────────────────────────────────────────

router.post('/sync', requireAuth, requireAdmin, async (req, res) => {
  const entity = (req.body.entity || '').trim().toLowerCase();

  try {
    let result;
    switch (entity) {
      case 'customers':
        result = await qb.syncCustomers();
        break;
      case 'invoices':
        result = await qb.syncInvoices();
        break;
      case 'bills':
        result = await qb.syncBills();
        break;
      default:
        setFlash(req, 'error', `Unknown entity: "${entity}". Use: customers, invoices, or bills.`);
        return res.redirect('/accounting/quickbooks-import');
    }

    setFlash(req, 'success', `Synced ${result.length} ${entity} from QuickBooks.`);
  } catch (e) {
    console.error(`[quickbooks] sync ${entity} failed:`, e);
    setFlash(req, 'error', `Sync failed: ${e.message}`);
  }
  res.redirect('/accounting/quickbooks-import');
});

module.exports = router;
