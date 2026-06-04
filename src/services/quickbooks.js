/**
 * quickbooks.js — QuickBooks Online OAuth 2.0 + API client
 *
 * Uses Intuit's OAuth 2.0 flow:
 *   Connect → callback (code exchange) → token refresh → API calls
 *
 * Env vars required (set in Vercel):
 *   QB_CLIENT_ID       — from Intuit Developer Portal
 *   QB_CLIENT_SECRET   — from Intuit Developer Portal
 *   QB_ENV             — "production" or "sandbox" (default production)
 *   PUBLIC_BASE_URL    — e.g. https://forge-recon.vercel.app
 */

const supabase = require('../db/supabase');
const crypto = require('crypto');

// ── Config ─────────────────────────────────────────────────────────────────────

const CLIENT_ID = process.env.QB_CLIENT_ID;
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const IS_SANDBOX = (process.env.QB_ENV || 'production') === 'sandbox';
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app';
const REDIRECT_URI = `${BASE_URL}/accounting/quickbooks/callback`;

const AUTH_ENDPOINT = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = IS_SANDBOX
  ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
  : 'https://quickbooks.api.intuit.com/v3/company';

const SCOPES = 'com.intuit.quickbooks.accounting';

// ── Token Storage ──────────────────────────────────────────────────────────────

async function getTokenRow() {
  const { data, error } = await supabase
    .from('quickbooks_tokens')
    .select('*')
    .is('disconnected_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveTokens({ realmId, accessToken, refreshToken, expiresIn, refreshTokenExpiresIn }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const refreshExpiresAt = refreshTokenExpiresIn
    ? new Date(now.getTime() + refreshTokenExpiresIn * 1000).toISOString()
    : null;

  // Deactivate any existing active token
  await supabase
    .from('quickbooks_tokens')
    .update({ disconnected_at: now.toISOString() })
    .is('disconnected_at', null);

  const { data, error } = await supabase
    .from('quickbooks_tokens')
    .insert({
      realm_id: realmId || null,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      refresh_token_expires_at: refreshExpiresAt,
      connected_at: now.toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

// ── OAuth Flow ─────────────────────────────────────────────────────────────────

/**
 * Generate the Intuit OAuth authorization URL.
 */
function getAuthUrl() {
  if (!CLIENT_ID) throw new Error('QB_CLIENT_ID not configured.');
  const state = crypto.randomBytes(24).toString('hex');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state };
}

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(code) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('QuickBooks client credentials not configured.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
    refreshTokenExpiresIn: data.x_refresh_token_expires_in,
    realmId: data.realm_id,
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
async function refreshAccessToken(refreshToken) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('QuickBooks client credentials not configured.');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
    refreshTokenExpiresIn: data.x_refresh_token_expires_in,
    realmId: data.realm_id,
  };
}

/**
 * Get a valid access token (auto-refresh if expired).
 */
async function getValidAccessToken() {
  const row = await getTokenRow();
  if (!row) throw new Error('No QuickBooks connection. Connect your QuickBooks account first.');

  const now = new Date();
  const expiresAt = new Date(row.expires_at);

  if (expiresAt > now) {
    return { accessToken: row.access_token, realmId: row.realm_id };
  }

  // Token expired — refresh it
  const refreshed = await refreshAccessToken(row.refresh_token);

  // Save new tokens and disconnect old row
  const nowISO = now.toISOString();
  await supabase
    .from('quickbooks_tokens')
    .update({ disconnected_at: nowISO })
    .eq('id', row.id);

  const { data: newRow } = await supabase
    .from('quickbooks_tokens')
    .insert({
      realm_id: refreshed.realmId || row.realm_id,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      expires_at: new Date(now.getTime() + refreshed.expiresIn * 1000).toISOString(),
      refresh_token_expires_at: refreshed.refreshTokenExpiresIn
        ? new Date(now.getTime() + refreshed.refreshTokenExpiresIn * 1000).toISOString()
        : null,
      connected_at: nowISO,
    })
    .select('id')
    .single();

  return { accessToken: refreshed.accessToken, realmId: refreshed.realmId || row.realm_id };
}

// ── API Client ─────────────────────────────────────────────────────────────────

/**
 * Make a QuickBooks API call with automatic token refresh.
 */
async function api(path, options = {}) {
  const { accessToken, realmId } = await getValidAccessToken();
  if (!realmId) throw new Error('No QuickBooks company connected (missing realmId).');

  const url = `${API_BASE}/${realmId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QuickBooks API error (${res.status}): ${text}`);
  }

  return res.json();
}

// ── Sync Helpers ───────────────────────────────────────────────────────────────

/**
 * Log a sync event.
 */
async function logSync(entityType, action, summary, details = null) {
  const { error } = await supabase.from('quickbooks_sync_log').insert({
    entity_type: entityType,
    action,
    summary,
    details: details ? JSON.stringify(details) : null,
  });
  if (error) console.warn('[quickbooks] sync log insert failed:', error.message);
}

/**
 * Check if QuickBooks is connected.
 */
async function isConnected() {
  const row = await getTokenRow();
  return !!row;
}

// ── Entity Sync ────────────────────────────────────────────────────────────────

/**
 * Pull customers from QuickBooks.
 */
async function syncCustomers() {
  const data = await api('/query?query=select%20*%20from%20Customer%20maxResults%201000');
  const customers = data.QueryResponse?.Customer || [];
  await logSync('Customer', 'pull', `Pulled ${customers.length} customers from QuickBooks`, { count: customers.length });
  return customers;
}

/**
 * Pull invoices from QuickBooks.
 */
async function syncInvoices() {
  const data = await api('/query?query=select%20*%20from%20Invoice%20maxResults%201000');
  const invoices = data.QueryResponse?.Invoice || [];
  await logSync('Invoice', 'pull', `Pulled ${invoices.length} invoices from QuickBooks`, { count: invoices.length });
  return invoices;
}

/**
 * Pull bills from QuickBooks.
 */
async function syncBills() {
  const data = await api('/query?query=select%20*%20from%20Bill%20maxResults%201000');
  const bills = data.QueryResponse?.Bill || [];
  await logSync('Bill', 'pull', `Pulled ${bills.length} bills from QuickBooks`, { count: bills.length });
  return bills;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  saveTokens,
  isConnected,
  getTokenRow,
  logSync,
  syncCustomers,
  syncInvoices,
  syncBills,
  _internal: { getValidAccessToken, api, refreshAccessToken },
};
