let supabaseClient = null;

function db() {
  if (!supabaseClient) supabaseClient = require('../db/supabase');
  return supabaseClient;
}

const API_BASE = process.env.QUICKBOOKS_API_BASE || 'https://quickbooks.api.intuit.com';
const OAUTH_TOKEN_URL = process.env.QUICKBOOKS_OAUTH_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const OAUTH_AUTHORIZE_URL = process.env.QUICKBOOKS_OAUTH_AUTHORIZE_URL || 'https://appcenter.intuit.com/connect/oauth2';
const MINOR_VERSION = process.env.QUICKBOOKS_MINOR_VERSION || '75';

const PO_FIELD_CANDIDATES = [
  'customer_po_number',
  'customer_po',
  'po_number',
  'purchase_order_number',
  'purchase_order',
];

function isConfigured() {
  return !!(process.env.QUICKBOOKS_CLIENT_ID && process.env.QUICKBOOKS_CLIENT_SECRET);
}

function integrationStatus() {
  if (!isConfigured()) {
    return {
      configured: false,
      connected: false,
      message: 'QuickBooks client credentials are not configured.',
    };
  }
  return {
    configured: true,
    connected: false,
    message: 'QuickBooks credentials are configured. Connect a company or provide tokens before syncing.',
  };
}

function configuredStatus(connection = null) {
  const configured = isConfigured();
  const connected = !!(connection?.realm_id && (connection.refresh_token || connection.access_token));
  const defaultItemId = connection?.default_item_id || process.env.QUICKBOOKS_DEFAULT_ITEM_ID || null;
  return {
    configured,
    connected,
    defaultItemConfigured: !!defaultItemId,
    realmId: connection?.realm_id || process.env.QUICKBOOKS_REALM_ID || null,
    defaultItemId,
    defaultItemName: connection?.default_item_name || (process.env.QUICKBOOKS_DEFAULT_ITEM_ID ? 'Environment default' : null),
    message: !configured
      ? 'QuickBooks client credentials are not configured.'
      : connected
        ? 'QuickBooks company is connected.'
        : 'QuickBooks credentials are configured. Connect a company before syncing.',
  };
}

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function dateOnly(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function stripNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function escapeQboQueryValue(value) {
  return String(value || '').replace(/'/g, "\\'");
}

function invoicePoNumber(invoice) {
  for (const key of PO_FIELD_CANDIDATES) {
    const value = invoice[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function authHeader() {
  const raw = `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

async function loadConnection() {
  if (!isConfigured()) return null;

  try {
    const { data, error } = await db()
      .from('quickbooks_connections')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  } catch (error) {
    // The migration may not be deployed yet; fall back to env tokens.
  }

  const realmId = process.env.QUICKBOOKS_REALM_ID;
  const refreshToken = process.env.QUICKBOOKS_REFRESH_TOKEN;
  const accessToken = process.env.QUICKBOOKS_ACCESS_TOKEN;
  if (!realmId || (!refreshToken && !accessToken)) return null;
  return {
    id: 1,
    realm_id: realmId,
    refresh_token: refreshToken || null,
    access_token: accessToken || null,
    access_token_expires_at: process.env.QUICKBOOKS_ACCESS_TOKEN_EXPIRES_AT || null,
    default_item_id: process.env.QUICKBOOKS_DEFAULT_ITEM_ID || null,
    default_item_name: process.env.QUICKBOOKS_DEFAULT_ITEM_ID ? 'Environment default' : null,
  };
}

async function saveConnectionToken(connection, tokenJson) {
  const expiresIn = Number(tokenJson.expires_in) || 3600;
  const refreshExpiresIn = Number(tokenJson.x_refresh_token_expires_in) || null;
  const now = Date.now();
  const row = {
    id: 1,
    realm_id: connection.realm_id,
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token || connection.refresh_token,
    token_type: tokenJson.token_type || 'bearer',
    access_token_expires_at: new Date(now + Math.max(0, expiresIn - 60) * 1000).toISOString(),
    refresh_token_expires_at: refreshExpiresIn ? new Date(now + refreshExpiresIn * 1000).toISOString() : connection.refresh_token_expires_at || null,
    updated_at: new Date().toISOString(),
    default_item_id: connection.default_item_id || null,
    default_item_name: connection.default_item_name || null,
    default_income_account_id: connection.default_income_account_id || null,
    default_income_account_name: connection.default_income_account_name || null,
    settings_updated_at: connection.settings_updated_at || null,
  };

  try {
    await db().from('quickbooks_connections').upsert(row, { onConflict: 'id' });
  } catch (error) {
    // Env-only deployments cannot persist refreshed tokens. The sync can still
    // finish with the in-memory token returned by Intuit.
  }
  return { ...connection, ...row };
}

function authorizationUrl({ redirectUri, state }) {
  if (!isConfigured()) throw new Error('QuickBooks client credentials are not configured.');
  const params = new URLSearchParams({
    client_id: process.env.QUICKBOOKS_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeAuthorizationCode({ code, realmId, redirectUri, userId }) {
  if (!isConfigured()) throw new Error('QuickBooks client credentials are not configured.');
  if (!code || !realmId) throw new Error('QuickBooks did not return an authorization code and company id.');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`QuickBooks authorization failed: ${json.error_description || json.error || response.status}`);
  }
  const existingConnection = await loadConnection();
  const connection = {
    ...(existingConnection || {}),
    id: 1,
    realm_id: realmId,
    connected_by_user_id: userId || null,
    connected_at: new Date().toISOString(),
  };
  return saveConnectionToken(connection, json);
}

async function disconnect() {
  await db().from('quickbooks_connections').delete().eq('id', 1);
}

function tokenIsFresh(connection) {
  if (!connection.access_token) return false;
  if (!connection.access_token_expires_at) return true;
  return new Date(connection.access_token_expires_at).getTime() > Date.now() + 60_000;
}

async function getAccessConnection() {
  let connection = await loadConnection();
  if (!connection) {
    throw new Error('QuickBooks is not connected. Add QUICKBOOKS credentials/tokens or connect a company before syncing.');
  }
  if (tokenIsFresh(connection)) return connection;
  if (!connection.refresh_token) {
    throw new Error('QuickBooks access token expired and no refresh token is available.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: connection.refresh_token,
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`QuickBooks token refresh failed: ${json.error_description || json.error || response.status}`);
  }
  connection = await saveConnectionToken(connection, json);
  return connection;
}

async function qboRequest(connection, path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API_BASE}${path}${separator}minorversion=${encodeURIComponent(MINOR_VERSION)}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fault = json.Fault?.Error?.[0];
    throw new Error(fault?.Detail || fault?.Message || `QuickBooks request failed (${response.status})`);
  }
  return json;
}

async function qboQuery(connection, query) {
  const encoded = encodeURIComponent(query);
  return qboRequest(connection, `/v3/company/${connection.realm_id}/query?query=${encoded}`, { method: 'GET' });
}

async function listItems(connection) {
  const response = await qboQuery(connection, 'select * from Item where Active = true maxresults 1000');
  return response.QueryResponse?.Item || [];
}

async function listIncomeAccounts(connection) {
  const response = await qboQuery(connection, "select * from Account where AccountType = 'Income' and Active = true maxresults 1000");
  return response.QueryResponse?.Account || [];
}

async function setDefaultItem({ itemId, itemName, incomeAccountId, incomeAccountName }) {
  if (!itemId) throw new Error('Choose a QuickBooks product/service item.');
  const row = {
    id: 1,
    default_item_id: String(itemId),
    default_item_name: itemName ? String(itemName) : null,
    default_income_account_id: incomeAccountId ? String(incomeAccountId) : null,
    default_income_account_name: incomeAccountName ? String(incomeAccountName) : null,
    settings_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db().from('quickbooks_connections').upsert(row, { onConflict: 'id' });
  if (error) throw error;
  return row;
}

function customerDisplayName(invoice) {
  return invoice.customer_name || invoice.job_title || `Forge customer ${invoice.customer_id || invoice.id}`;
}

async function logSync({ entityType, entityId, action, status, quickbooksId, message, request, response, userId }) {
  try {
    await db().from('quickbooks_sync_logs').insert({
      entity_type: entityType,
      entity_id: entityId,
      action,
      status,
      quickbooks_id: quickbooksId || null,
      message: message || null,
      request_json: request || null,
      response_json: response || null,
      user_id: userId || null,
    });
  } catch (error) {
    // Best-effort logging only.
  }
}

async function updateCustomerQuickBooksId(customerId, quickbooksId) {
  if (!customerId || !quickbooksId) return;
  try {
    await db().from('customers').update({
      quickbooks_id: quickbooksId,
      quickbooks_sync_error: null,
      quickbooks_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', customerId);
  } catch (error) {
    // Column migration may not be deployed yet.
  }
}

async function findOrCreateCustomer(connection, invoice, userId) {
  if (invoice.customer_quickbooks_id) return invoice.customer_quickbooks_id;

  if (invoice.customer_id) {
    try {
      const { data } = await db()
        .from('customers')
        .select('quickbooks_id')
        .eq('id', invoice.customer_id)
        .maybeSingle();
      if (data?.quickbooks_id) return data.quickbooks_id;
    } catch (error) {
      // Column may not exist yet.
    }
  }

  const displayName = customerDisplayName(invoice);
  const query = `select * from Customer where DisplayName = '${escapeQboQueryValue(displayName)}'`;
  const found = await qboQuery(connection, query);
  const existing = found.QueryResponse?.Customer?.[0];
  if (existing?.Id) {
    await updateCustomerQuickBooksId(invoice.customer_id, existing.Id);
    await logSync({
      entityType: 'customer',
      entityId: invoice.customer_id || invoice.id,
      action: 'match',
      status: 'success',
      quickbooksId: existing.Id,
      message: `Matched QuickBooks customer ${displayName}.`,
      userId,
    });
    return existing.Id;
  }

  const payload = stripNulls({
    DisplayName: displayName,
    CompanyName: displayName,
    PrimaryEmailAddr: invoice.customer_email ? { Address: invoice.customer_email } : null,
    PrimaryPhone: invoice.customer_phone ? { FreeFormNumber: invoice.customer_phone } : null,
    BillAddr: stripNulls({
      Line1: invoice.customer_address,
      City: invoice.customer_city,
      CountrySubDivisionCode: invoice.customer_state,
      PostalCode: invoice.customer_zip,
    }),
  });
  const created = await qboRequest(connection, `/v3/company/${connection.realm_id}/customer`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const quickbooksId = created.Customer?.Id;
  if (!quickbooksId) throw new Error('QuickBooks did not return a customer id.');
  await updateCustomerQuickBooksId(invoice.customer_id, quickbooksId);
  await logSync({
    entityType: 'customer',
    entityId: invoice.customer_id || invoice.id,
    action: 'create',
    status: 'success',
    quickbooksId,
    request: payload,
    response: created.Customer || created,
    userId,
  });
  return quickbooksId;
}

function lineItemPayload(line, defaultItemId) {
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: money(line.line_total),
    Description: line.description || 'Invoice line item',
    SalesItemLineDetail: {
      ItemRef: { value: defaultItemId },
      Qty: Number(line.quantity) || 0,
      UnitPrice: money(line.unit_price),
      TaxCodeRef: { value: process.env.QUICKBOOKS_NON_TAX_CODE_ID || 'NON' },
    },
  };
}

function buildInvoicePayload(invoice, quickbooksCustomerId, options = {}) {
  const defaultItemId = options.defaultItemId || process.env.QUICKBOOKS_DEFAULT_ITEM_ID;
  if (!defaultItemId) {
    throw new Error('QuickBooks default product/service item is required so Forge can map invoice lines to QuickBooks.');
  }
  if (!invoice.lines || invoice.lines.length === 0) {
    throw new Error('Invoice has no line items to sync.');
  }
  if (money(invoice.tax_amount) > 0 && !process.env.QUICKBOOKS_TAX_CODE_ID) {
    throw new Error('Taxed invoices need QUICKBOOKS_TAX_CODE_ID configured before QuickBooks sync.');
  }

  const poNumber = invoicePoNumber(invoice);
  const memoParts = [
    invoice.notes,
    poNumber ? `Customer PO: ${poNumber}` : null,
    `Forge invoice id: ${invoice.id}`,
  ].filter(Boolean);

  const payload = stripNulls({
    CustomerRef: { value: quickbooksCustomerId },
    DocNumber: invoice.quickbooks_doc_number || invoice.display_number,
    TxnDate: dateOnly(invoice.sent_at) || dateOnly(invoice.created_at) || dateOnly(new Date().toISOString()),
    DueDate: dateOnly(invoice.due_date),
    BillEmail: (invoice.customer_billing_email || invoice.customer_email) ? { Address: invoice.customer_billing_email || invoice.customer_email } : null,
    BillAddr: stripNulls({
      Line1: invoice.customer_address,
      City: invoice.customer_city,
      CountrySubDivisionCode: invoice.customer_state,
      PostalCode: invoice.customer_zip,
    }),
    ShipAddr: stripNulls({
      Line1: invoice.job_address || invoice.customer_address,
      City: invoice.job_city || invoice.customer_city,
      CountrySubDivisionCode: invoice.job_state || invoice.customer_state,
      PostalCode: invoice.job_zip || invoice.customer_zip,
    }),
    PrivateNote: memoParts.join('\n'),
    CustomerMemo: invoice.conditions ? { value: invoice.conditions } : null,
    CustomField: (poNumber && process.env.QUICKBOOKS_PO_CUSTOM_FIELD_ID) ? [{
      DefinitionId: process.env.QUICKBOOKS_PO_CUSTOM_FIELD_ID,
      Name: 'Customer PO',
      Type: 'StringType',
      StringValue: poNumber,
    }] : null,
    Line: invoice.lines.map(line => lineItemPayload(line, defaultItemId)),
  });

  if (money(invoice.tax_amount) > 0 && process.env.QUICKBOOKS_TAX_CODE_ID) {
    payload.Line = payload.Line.map(line => ({
      ...line,
      SalesItemLineDetail: {
        ...line.SalesItemLineDetail,
        TaxCodeRef: { value: process.env.QUICKBOOKS_TAX_CODE_ID },
      },
    }));
  }

  return payload;
}

async function loadQuickBooksInvoice(connection, quickbooksId) {
  if (!quickbooksId) return null;
  const response = await qboRequest(connection, `/v3/company/${connection.realm_id}/invoice/${quickbooksId}`, { method: 'GET' });
  return response.Invoice || null;
}

async function findInvoiceByDocNumber(connection, docNumber) {
  if (!docNumber) return null;
  const query = `select * from Invoice where DocNumber = '${escapeQboQueryValue(docNumber)}'`;
  const found = await qboQuery(connection, query);
  return found.QueryResponse?.Invoice?.[0] || null;
}

async function saveInvoiceSync(invoice, connection, qboInvoice, payload, status = 'billing_complete') {
  const quickbooksId = qboInvoice.Id;
  const updates = {
    quickbooks_id: quickbooksId,
    quickbooks_doc_number: qboInvoice.DocNumber || payload.DocNumber || invoice.display_number,
    quickbooks_sync_status: 'synced',
    quickbooks_synced_at: new Date().toISOString(),
    quickbooks_sync_error: null,
    quickbooks_realm_id: connection.realm_id,
    quickbooks_sync_payload: payload,
    updated_at: new Date().toISOString(),
  };
  if (status) updates.status = status;
    await db().from('invoices').update(updates).eq('id', invoice.id);
}

async function markInvoiceSyncFailed(invoiceId, message) {
  try {
    await db().from('invoices').update({
      quickbooks_sync_status: 'failed',
      quickbooks_sync_error: message,
      updated_at: new Date().toISOString(),
    }).eq('id', invoiceId);
  } catch (error) {
    // Column migration may not be deployed yet.
  }
}

async function syncInvoice(invoice, { userId } = {}) {
  if (!isConfigured()) {
    throw new Error('QuickBooks sync is not configured. Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET first.');
  }
  if (!['sent', 'overdue', 'paid', 'billing_complete'].includes(invoice.status)) {
    throw new Error(`Only sent, overdue, paid, or billing-complete invoices can sync to QuickBooks. Current status: ${invoice.status}.`);
  }

  const connection = await getAccessConnection();
  const quickbooksCustomerId = await findOrCreateCustomer(connection, invoice, userId);
  const payload = buildInvoicePayload(invoice, quickbooksCustomerId, { defaultItemId: connection.default_item_id });

  try {
    await db().from('invoices').update({
      quickbooks_sync_status: 'pending',
      quickbooks_sync_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', invoice.id);
  } catch (error) {
    // Column migration may not be deployed yet.
  }

  let action = 'create';
  let existing = null;
  if (invoice.quickbooks_id) {
    existing = await loadQuickBooksInvoice(connection, invoice.quickbooks_id);
  }
  if (!existing) {
    existing = await findInvoiceByDocNumber(connection, payload.DocNumber);
    if (existing?.Id) action = 'match';
  } else {
    action = 'update';
  }

  let qboInvoice;
  let response;
  if (existing?.Id) {
    const updatePayload = {
      ...payload,
      Id: existing.Id,
      SyncToken: existing.SyncToken,
      sparse: false,
    };
    response = await qboRequest(connection, `/v3/company/${connection.realm_id}/invoice`, {
      method: 'POST',
      body: JSON.stringify(updatePayload),
    });
    qboInvoice = response.Invoice;
  } else {
    response = await qboRequest(connection, `/v3/company/${connection.realm_id}/invoice`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    qboInvoice = response.Invoice;
  }

  if (!qboInvoice?.Id) throw new Error('QuickBooks did not return an invoice id.');
  await saveInvoiceSync(invoice, connection, qboInvoice, payload, 'billing_complete');
  await logSync({
    entityType: 'invoice',
    entityId: invoice.id,
    action,
    status: 'success',
    quickbooksId: qboInvoice.Id,
    request: payload,
    response: qboInvoice,
    userId,
  });
  return qboInvoice;
}

module.exports = {
  isConfigured,
  integrationStatus,
  configuredStatus,
  authorizationUrl,
  exchangeAuthorizationCode,
  loadConnection,
  getAccessConnection,
  listItems,
  listIncomeAccounts,
  setDefaultItem,
  disconnect,
  invoicePoNumber,
  buildInvoicePayload,
  syncInvoice,
  _internal: {
    escapeQboQueryValue,
    lineItemPayload,
    money,
  },
};
