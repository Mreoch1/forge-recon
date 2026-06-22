/**
 * Invoices CRUD (Supabase SDK).
 *
 * Created via POST /estimates/:id/generate-invoice (1:1 with estimate).
 * Display number = WO's display number, prefixed INV-.
 * Recipient for send: customer.billing_email (falls back to customer.email).
 * Payment terms: presets (Due on receipt / Net 15 / Net 30 / Net 45 / Net 60 / Custom).
 *
 *   GET   /                    list (with overdue display)
 *   GET   /:id                 show
 *   GET   /:id/edit            edit open invoices
 *   POST  /:id                 update
 *   POST  /:id/send            email PDF to billing_email
 *   POST  /:id/mark-sent       draft -> sent without emailing
 *   POST  /:id/status          admin manual status correction
 *   POST  /:id/mark-paid       sent|overdue -> paid (or partial; stays sent)
 *   POST  /:id/void            any non-paid -> void
 *   GET   /:id/pdf             PDF
 *   POST  /:id/delete          void only
 */

const express = require('express');
const supabase = require('../db/supabase');
const { requireAdmin, setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');
const email = require('../services/email');
const posting = require('../services/accounting-posting');
const { writeAudit } = require('../services/audit');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { listEntityActivity } = require('../services/activity');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'sent', 'paid', 'billing_complete', 'overdue', 'void'];
const MANUAL_STATUSES = ['draft', 'sent', 'overdue', 'billing_complete'];
const VALID_UNITS = ['ea', 'hr', 'sqft', 'lf', 'ton', 'lot'];
const PAYMENT_TERMS_PRESETS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function asArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input !== 'object') return [];
  return Object.keys(input).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map(k => input[k]);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtMoney(value) {
  const num = Number(value);
  return `$${(Number.isFinite(num) ? num : 0).toFixed(2)}`;
}

function invoiceBalance(invoice) {
  return (Number(invoice.total) || 0) - (Number(invoice.amount_paid) || 0);
}

function isInvoicePastDue(invoice) {
  if (!invoice || invoice.status !== 'sent' || !invoice.due_date || invoiceBalance(invoice) <= 0) return false;
  const dueAt = new Date(`${String(invoice.due_date).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dueAt.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueAt < today;
}

async function markInvoiceOverdue(invoice, req) {
  if (!isInvoicePastDue(invoice)) return invoice;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('invoices')
    .update({ status: 'overdue', updated_at: now })
    .eq('id', invoice.id)
    .eq('status', 'sent');
  if (error) throw error;
  try {
    await writeAudit({
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'status_auto_overdue',
      before: { status: 'sent' },
      after: { status: 'overdue', due_date: invoice.due_date },
      source: 'system',
      userId: req?.session?.userId || null,
    });
  } catch (e) { /* best-effort */ }
  return { ...invoice, status: 'overdue', updated_at: now };
}

async function refreshPastDueInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('invoices')
    .update({ status: 'overdue', updated_at: new Date().toISOString() })
    .eq('status', 'sent')
    .lt('due_date', today);
  if (error) throw error;
}

function paymentTermsFromBody(body, fallback = 'Net 30') {
  const selected = emptyToNull(body.payment_terms);
  if (selected === '__custom') return emptyToNull(body.payment_terms_custom) || fallback;
  return selected || fallback;
}

function customerFacingInvoice(invoice) {
  return {
    ...invoice,
    cost_total: undefined,
    lines: (invoice.lines || []).map(li => ({
      trade: li.trade || '',
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      unit_price: li.unit_price,
      line_total: li.line_total,
    })),
  };
}

function buildInvoiceEmailBody(invoice, company = {}) {
  const safeCompany = escapeHtml(company.company_name || 'Recon Enterprises');
  const safeCustomer = escapeHtml(invoice.customer_name || 'there');
  const safeInvoiceNumber = escapeHtml(invoice.display_number);
  const safeWoNumber = escapeHtml(invoice.wo_display_number || '');
  const terms = escapeHtml(invoice.payment_terms || company.default_payment_terms || 'Net 30');
  const due = invoice.due_date ? escapeHtml(String(invoice.due_date).slice(0, 10)) : '';
  const balance = (Number(invoice.total) || 0) - (Number(invoice.amount_paid) || 0);
  const rows = (invoice.lines || []).map(li => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eeeeee;">${escapeHtml(li.description || '')}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eeeeee;text-align:right;white-space:nowrap;">${escapeHtml(li.quantity || 0)} ${escapeHtml(li.unit || '')}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eeeeee;text-align:right;white-space:nowrap;">${fmtMoney(li.line_total)}</td>
    </tr>
  `).join('');

  // R37j: surface unit_number + job site as a Job Site block, and put Due date on its own line.
  const safeUnit = escapeHtml(invoice.unit_number || '');
  const jobAddress = invoice.job_address || invoice.customer_address || '';
  const jobCSZ = [invoice.job_city || invoice.customer_city, invoice.job_state || invoice.customer_state, invoice.job_zip || invoice.customer_zip].filter(Boolean).join(', ');
  const safeJobAddress = escapeHtml(jobAddress);
  const safeJobCSZ = escapeHtml(jobCSZ);
  const safeJobTitle = escapeHtml(invoice.job_title || '');

  return `
    <p style="margin-top:0;">Hi ${safeCustomer},</p>
    <p>${safeCompany} prepared invoice <strong>${safeInvoiceNumber}</strong>${safeWoNumber ? ` for work order <strong>${safeWoNumber}</strong>` : ''}. The full invoice PDF is attached.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;border-collapse:collapse;">
      <tr>
        <td style="padding:14px 16px;background:#f5f5f5;border-radius:6px;">
          <span style="display:block;color:#777;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Amount due</span>
          <span style="display:block;color:#c0202b;font-size:28px;font-weight:800;line-height:1.2;">${fmtMoney(balance)}</span>
          <span style="display:block;color:#777;font-size:13px;margin-top:6px;">Terms: ${terms}</span>
          ${due ? `<span style="display:block;color:#c0202b;font-size:14px;font-weight:700;margin-top:4px;">Due: ${due}</span>` : ''}
        </td>
      </tr>
    </table>
    ${(safeUnit || safeJobAddress || safeJobTitle) ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 14px;background:#fafafa;border-left:3px solid #c0202b;border-radius:4px;font-size:13px;color:#444;">
            <span style="display:block;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Job site</span>
            ${safeJobTitle ? `<span style="display:block;font-weight:600;color:#1a1a1a;">${safeJobTitle}</span>` : ''}
            ${safeUnit ? `<span style="display:block;">Unit ${safeUnit}</span>` : ''}
            ${safeJobAddress ? `<span style="display:block;">${safeJobAddress}</span>` : ''}
            ${safeJobCSZ ? `<span style="display:block;">${safeJobCSZ}</span>` : ''}
          </td>
        </tr>
      </table>
    ` : ''}
    ${rows ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;">
        <thead>
          <tr>
            <th align="left" style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #dddddd;padding-bottom:8px;">Item</th>
            <th align="right" style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #dddddd;padding-bottom:8px;">Qty</th>
            <th align="right" style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #dddddd;padding-bottom:8px;">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    ` : ''}
    <p>Please send payment according to the terms above. For questions, contact <a href="mailto:Office@reconenterprises.net" style="color:#c0202b;">Office@reconenterprises.net</a>.</p>
    <p style="margin-bottom:0;">Thanks,<br>${safeCompany}</p>
  `;
}

function validateLineItem(li) {
  const description = emptyToNull(li.description);
  const unit = emptyToNull(li.unit) || 'ea';
  const quantity = parseFloat(li.quantity);
  const unitPrice = parseFloat(li.unit_price);
  const cost = parseFloat(li.cost);
  const laborCost = parseFloat(li.labor_cost);
  const materialCost = parseFloat(li.material_cost);
  const markupPct = parseFloat(li.markup_pct);
  return {
    data: {
      description,
      quantity: isFinite(quantity) && quantity >= 0 ? quantity : 0,
      unit: VALID_UNITS.includes(unit) ? unit : 'ea',
      unit_price: isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      cost: isFinite(cost) && cost >= 0 ? cost : 0,
      labor_cost: isFinite(laborCost) && laborCost >= 0 ? laborCost : 0,
      material_cost: isFinite(materialCost) && materialCost >= 0 ? materialCost : 0,
      markup_pct: isFinite(markupPct) && markupPct >= 0 ? markupPct : 25,
    }
  };
}

function validateInvoice(body) {
  const errors = {};
  const dueDate = emptyToNull(body.due_date);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors.due_date = 'Use YYYY-MM-DD.';
  const taxRate = parseFloat(body.tax_rate);
  const taxRateNum = isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;
  const paymentTerms = paymentTermsFromBody(body);
  const notes = emptyToNull(body.notes);
  const conditions = emptyToNull(body.conditions);
  const poNumber = emptyToNull(body.po_number);

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    if (!emptyToNull(li.description)) return;
    items.push(validateLineItem(li).data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';

  return {
    errors,
    data: { due_date: dueDate, tax_rate: taxRateNum, payment_terms: paymentTerms, notes, conditions, po_number: poNumber, lines: items }
  };
}

async function loadInvoice(id) {
  // Nested selects rely on FKs: invoices.work_order_id -> work_orders,
  // with direct work_orders.customer_id preferred and legacy jobs as fallback.
  const { data: inv, error } = await supabase
    .from('invoices')
    .select(`
      *,
      work_orders!left(id, display_number, customer_id, unit_number,
        customers!left(id, name, email, billing_email, phone, address, city, state, zip, quickbooks_id),
        jobs!left(id, title, address, city, state, zip,
        customers!left(id, name, email, billing_email, phone, address, city, state, zip, quickbooks_id)))
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!inv) return null;

  // Flatten nested data to match view expectations
  const w = inv.work_orders;
  const j = w?.jobs;
  const c = w?.customers || j?.customers;
  inv.wo_id = w?.id;
  inv.wo_display_number = w?.display_number;
  inv.unit_number = w?.unit_number || null;  // R37j: surface WO unit_number for invoice PDF/email
  inv.job_id = j?.id;
  inv.job_title = j?.title || (c?.name ? `${c.name} work order` : 'Customer work order');
  inv.job_address = j?.address;
  inv.job_city = j?.city;
  inv.job_state = j?.state;
  inv.job_zip = j?.zip;
  inv.customer_id = c?.id;
  inv.customer_name = c?.name;
  inv.customer_email = c?.email;
  inv.customer_billing_email = c?.billing_email;
  inv.customer_phone = c?.phone;
  inv.customer_quickbooks_id = c?.quickbooks_id;
  inv.customer_address = c?.address;
  inv.customer_city = c?.city;
  inv.customer_state = c?.state;
  inv.customer_zip = c?.zip;
  delete inv.work_orders;

  if (inv.sent_by_user_id) {
    const { data: sentBy } = await supabase
      .from('users')
      .select('name')
      .eq('id', inv.sent_by_user_id)
      .maybeSingle();
    inv.sent_by_name = sentBy?.name || null;
  }

  const { data: lines, error: lineErr } = await supabase
    .from('invoice_line_items')
    .select('*')
    .eq('invoice_id', id)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (lineErr) throw lineErr;
  inv.lines = lines || [];
  inv.display_number = `INV-${inv.wo_display_number || '????-????'}`;
  return inv;
}

async function loadCompanySettings() {
  const { data, error } = await supabase
    .from('company_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

router.get('/', async (req, res) => {
  await refreshPastDueInvoices();

  // F4: sanitize before interpolating into PostgREST .or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('invoices')
    .select(`
      id, status, total, amount_paid, due_date, created_at, payment_terms, qb_synced_at,
      work_orders!left(
        id, display_number, customer_id,
        customers!left(id, name),
        jobs!left(id, title, customers!left(id, name))
      )
    `, { count: 'exact', head: false });

  if (q) {
    // Nested relation filters can break when WOs no longer require jobs.
    // Keep the database query broad and apply the mixed customer/legacy search below.
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  const { data: rows, count: total, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;

  const filtered = q
    ? (rows || []).filter(r => {
        const haystack = [
          r.work_orders?.display_number,
          r.work_orders?.customers?.name,
          r.work_orders?.jobs?.title,
          r.work_orders?.jobs?.customers?.name,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q.toLowerCase());
      })
    : (rows || []);

  const invoices = filtered.map(r => ({
    id: r.id, status: r.status, total: r.total, amount_paid: r.amount_paid,
    due_date: r.due_date, created_at: r.created_at, payment_terms: r.payment_terms,
    qb_synced_at: r.qb_synced_at,
    wo_id: r.work_orders?.id,
    wo_display_number: r.work_orders?.display_number,
    job_id: r.work_orders?.jobs?.id,
    job_title: r.work_orders?.jobs?.title || (r.work_orders?.customers?.name ? `${r.work_orders.customers.name} work order` : 'Customer work order'),
    customer_id: r.work_orders?.customers?.id || r.work_orders?.jobs?.customers?.id,
    customer_name: r.work_orders?.customers?.name || r.work_orders?.jobs?.customers?.name,
  }));

  res.render('invoices/index', {
    title: 'Invoices', activeNav: 'invoices',
    invoices, q, status, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES,
  });
});

// POST /batch-csv — download selected invoices as a single CSV
router.post('/batch-csv', async (req, res) => {
  const raw = req.body.invoice_ids;
  const ids = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Boolean);
  if (!ids.length) {
    setFlash(req, 'error', 'No invoices selected.');
    return res.redirect('/invoices');
  }

  let csv = 'Invoice No,Customer Name,Invoice Date,Due Date,Terms,Service Date,Product/Service,Item Description,Item Quantity,Item Rate,Item Amount,Taxable,Item Tax Code,Memo,Email,PO Number\n';

  for (const id of ids) {
    try {
      const invoice = await loadInvoice(id);
      if (!invoice) continue;
      const invNum = invoice.display_number;
      const custName = invoice.customer_name || 'Unknown';

      // Format dates as M/D/YYYY for QuickBooks
      const invDate = invoice.created_at ? new Date(invoice.created_at).toLocaleDateString('en-US') : '';
      const dueDate = invoice.due_date ? new Date(invoice.due_date + 'T00:00:00').toLocaleDateString('en-US') : '';

      const terms = invoice.payment_terms || '';
      const email = invoice.customer_billing_email || invoice.customer_email || '';
      const poNum = invoice.po_number || '';
      const isTaxable = Number(invoice.tax_rate || 0) > 0;
      const taxable = isTaxable ? 'Y' : 'N';
      const taxCode = isTaxable ? 'TAX' : 'NON';
      const lines = (invoice.lines || []).length > 0 ? invoice.lines : [{ description: 'Invoice', quantity: 1, unit_price: invoice.total, line_total: invoice.total }];

      lines.forEach(li => {
        const desc = (li.description || '').replace(/"/g, '""');
        const item = 'Recon Services';
        const memo = (invoice.notes || '').replace(/"/g, '""');
        csv += `"${invNum}","${custName}","${invDate}","${dueDate}","${terms}","","${item}","${desc}",${li.quantity || 1},${li.unit_price || 0},${li.line_total || 0},"${taxable}","${taxCode}","${memo}","${email}","${poNum}"\n`;
      });
    } catch (e) { /* skip failed */ }
  }

  const dateStr = new Date().toISOString().slice(0, 10);

  // Mark exported invoices as synced so they don't appear in future batches
  try {
    const supabase = require('../db/supabase');
    const now = new Date().toISOString();
    for (const id of ids) {
      await supabase.from('invoices').update({ qb_synced_at: now }).eq('id', id);
    }
  } catch (e) { /* best-effort */ }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="forge-invoices-${dateStr}.csv"`);
  res.send(csv);
});

// D-100: stop-gap for /invoices/new — was returning HTTP 500 because Express
// matched "new" against /:id and the bigint cast failed. Invoices are normally
// created via POST /estimates/:id/create-invoice; /invoices/new isn't linked
// from anywhere but defensive redirect keeps it from crashing.
router.get('/new', (req, res) => {
  return res.redirect('/estimates');
});

// Defensive: constrain :id to digits so "new", "create", etc. never reach the
// bigint cast. Anything non-numeric falls through to a 404 below.
router.get('/:id(\\d+)', async (req, res) => {
  let invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  invoice = await markInvoiceOverdue(invoice, req);
  let displayStatus = invoice.status;

  // F-010: actual cost from linked vendor bills
  let actualCost = 0;
  if (invoice.wo_id) {
    try {
      const { data: actualBills } = await supabase
        .from('bills')
        .select('total')
        .eq('work_order_id', invoice.wo_id)
        .in('status', ['approved', 'paid']);
      actualCost = (actualBills || []).reduce(function(s, r) {
        var n = Number(r.total);
        return s + (isFinite(n) ? n : 0);
      }, 0);
    } catch (e) { /* best-effort */ }
  }
  const activity = await listEntityActivity({
    workOrderId: invoice.wo_id,
    estimateId: invoice.estimate_id,
    invoiceId: invoice.id,
  });

  res.render('invoices/show', {
    title: invoice.display_number, activeNav: 'invoices',
    invoice, displayStatus,
    actualCost, activity,
  });
});

router.post('/:id/activity-note', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  const body = (req.body.body || '').trim();
  if (!body || body.length < 2) {
    setFlash(req, 'error', 'Activity note must be at least 2 characters.');
    return res.redirect(`/invoices/${invoice.id}`);
  }
  await writeAudit({
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'note_added',
    before: null,
    after: { body },
    source: 'user',
    userId: req.session.userId,
  });
  setFlash(req, 'success', 'Activity note added.');
  res.redirect(`/invoices/${invoice.id}`);
});

router.get('/:id/edit', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (['paid', 'billing_complete', 'void'].includes(invoice.status)) {
    setFlash(req, 'error', `${invoice.display_number} is "${invoice.status}" — cannot edit.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  res.render('invoices/edit', {
    title: `Edit ${invoice.display_number}`, activeNav: 'invoices',
    invoice, errors: {}, units: VALID_UNITS, paymentTermsPresets: PAYMENT_TERMS_PRESETS
  });
});

router.post('/:id', async (req, res) => {
  const existing = await loadInvoice(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (['paid', 'billing_complete', 'void'].includes(existing.status)) {
    setFlash(req, 'error', `${existing.display_number} is "${existing.status}" — cannot edit.`);
    return res.redirect(`/invoices/${existing.id}`);
  }
  const { errors, data } = validateInvoice(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('invoices/edit', {
      title: `Edit ${existing.display_number}`, activeNav: 'invoices',
      invoice: { ...existing, ...data }, errors, units: VALID_UNITS,
      paymentTermsPresets: PAYMENT_TERMS_PRESETS
    });
  }
  const t = calc.totals(data.lines, data.tax_rate);
  const costTotal = data.lines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);

  // Transactional update via RPC: rewrites header + lines atomically.
  const lineRows = data.lines.map((li, idx) => ({
    description: li.description,
    quantity: li.quantity,
    unit: li.unit,
    unit_price: li.unit_price,
    cost: li.cost,
    line_total: calc.lineTotal(li),
    labor_cost: li.labor_cost || 0,
    material_cost: li.material_cost || 0,
    markup_pct: li.markup_pct != null ? li.markup_pct : 25,
    sort_order: idx,
  }));
  const { error: rpcErr } = await supabase.rpc('update_invoice_with_lines', {
    invoice_id: parseInt(existing.id, 10),
    invoice_data: {
      subtotal: t.subtotal,
      tax_rate: data.tax_rate,
      tax_amount: t.taxAmount,
      total: t.total,
      cost_total: costTotal,
      payment_terms: data.payment_terms,
      due_date: data.due_date,
      notes: data.notes,
      conditions: data.conditions,
    },
    lines: lineRows,
  });
  if (rpcErr) throw rpcErr;

  // D-113 fallback: if the RPC silently dropped `conditions` (e.g. older RPC
  // signature without the field), persist it via a direct UPDATE so the field
  // doesn't get lost on save. Tolerate column-missing gracefully.
  const { error: condError } = await supabase
    .from('invoices')
    .update({ conditions: data.conditions })
    .eq('id', existing.id);
  if (condError && condError.code !== '42703' && !String(condError.message || '').includes('conditions')) {
    console.warn('[invoices] conditions column update failed:', condError.message);
  }

  // Persist po_number (not part of RPC payload)
  const { error: poError } = await supabase
    .from('invoices')
    .update({ po_number: data.po_number || null })
    .eq('id', existing.id);
  if (poError && poError.code !== '42703') {
    console.warn('[invoices] po_number column update failed:', poError.message);
  }

  // RPC does not audit updates — write a separate audit row.
  try {
    const { error: auditErr } = await supabase.from('audit_logs').insert({
      entity_type: 'invoice',
      entity_id: existing.id,
      action: 'update',
      before_json: { total: existing.total },
      after_json: { total: t.total },
      source: 'user',
      user_id: req.session.userId,
    });
    if (auditErr) throw auditErr;
  } catch (e) { /* audit best-effort */ }

  setFlash(req, 'success', `${existing.display_number} updated.`);
  res.redirect(`/invoices/${existing.id}`);
});

router.post('/:id/send', async (req, res, next) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (!['draft', 'sent', 'overdue'].includes(invoice.status)) {
    setFlash(req, 'error', `${invoice.display_number} is "${invoice.status}" - cannot send email.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  try {
    const company = await loadCompanySettings();
    const customerInvoice = customerFacingInvoice(invoice);
    const buf = await pdf.renderToBuffer(pdf.generateInvoicePDF, { ...customerInvoice, invoice_number: invoice.display_number }, company);
    const recipient = invoice.customer_billing_email || invoice.customer_email;
    if (!recipient) throw new Error(`Invoice ${invoice.display_number} cannot be sent because the customer has no email address.`);
    const subject = `Invoice ${invoice.display_number} from ${company.company_name || 'Recon Enterprises'}`;
    const dueLine = invoice.due_date ? `Due: ${String(invoice.due_date).slice(0, 10)}` : '';
    const text = `Hello ${invoice.customer_name || ''},\n\nPlease find attached invoice ${invoice.display_number}.\nAmount due: $${((Number(invoice.total) || 0) - (Number(invoice.amount_paid) || 0)).toFixed(2)}\nTerms: ${invoice.payment_terms || company.default_payment_terms || 'Net 30'}\n${dueLine}\n\nThanks.\n${company.company_name || 'Recon Enterprises'}`;
    const sent = await email.sendEmail({
      to: recipient,
      subject,
      text,
      htmlBody: buildInvoiceEmailBody(invoice, company),
      attachments: [{ filename: `${invoice.display_number}.pdf`, content: buf, contentType: 'application/pdf' }]
    });

    const { error: updErr } = await supabase
      .from('invoices')
      .update({
        sent_at: new Date().toISOString(),
        sent_by_user_id: req.session.userId,
        sent_to_email: recipient,
        sent_to_name: invoice.customer_name || 'Unknown',
        status: 'sent',
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoice.id);
    if (updErr) throw updErr;

    try {
      await writeAudit({
        entityType: 'invoice', entityId: invoice.id, action: invoice.sent_at ? 'resend' : 'send',
        before: { status: invoice.status },
        after: { status: 'sent', recipient, sent_at: new Date().toISOString() },
        source: 'user', userId: req.session.userId,
      });
    } catch (e) { /* best-effort */ }

    if (invoice.status === 'draft') {
      try {
        await posting.postInvoiceSent(invoice, { userId: req.session.userId });
      } catch (e) {
        console.error('JE post failed (invoice send) - continuing:', e.message);
      }
    }

    const note = sent.mode === 'file' ? ` Email saved to ${sent.filepath}.` : '';
    setFlash(req, 'success', `${invoice.display_number} email sent to ${recipient}.${note}`);
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) { next(err); }
});

// Mark sent manually without emailing the customer.
router.post('/:id/mark-sent', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status !== 'draft') {
    setFlash(req, 'error', `${invoice.display_number} is "${invoice.status}" - only draft invoices can be marked sent.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const now = new Date().toISOString();
  const recipient = invoice.customer_billing_email || invoice.customer_email || null;
  const { error: updErr } = await supabase
    .from('invoices')
    .update({
      sent_at: now,
      sent_by_user_id: req.session.userId,
      sent_to_email: recipient,
      sent_to_name: invoice.customer_name || null,
      status: 'sent',
      updated_at: now,
    })
    .eq('id', invoice.id);
  if (updErr) throw updErr;

  try {
    await writeAudit({
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'marked_sent_manually',
      before: { status: invoice.status },
      after: { status: 'sent', sent_at: now, recipient },
      source: 'user',
      userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  try {
    await posting.postInvoiceSent(invoice, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (invoice mark sent) - continuing:', e.message);
  }

  setFlash(req, 'success', `${invoice.display_number} marked sent. No email was sent.`);
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/:id/status', requireAdmin, async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  const nextStatus = String(req.body.status || '').trim();
  if (!MANUAL_STATUSES.includes(nextStatus)) {
    setFlash(req, 'error', 'Choose a valid invoice status.');
    return res.redirect(`/invoices/${invoice.id}`);
  }
  if (invoice.status === 'paid' && nextStatus !== 'billing_complete') {
    setFlash(req, 'error', 'Paid invoices can only move to billing complete from the manual status control.');
    return res.redirect(`/invoices/${invoice.id}`);
  }
  if (invoice.status === nextStatus) {
    setFlash(req, 'success', `${invoice.display_number} is already ${nextStatus.replace(/_/g, ' ')}.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const now = new Date().toISOString();
  const updates = { status: nextStatus, updated_at: now };
  if (invoice.status === 'draft' && nextStatus === 'sent') {
    updates.sent_at = now;
    updates.sent_by_user_id = req.session.userId;
    updates.sent_to_email = invoice.customer_billing_email || invoice.customer_email || null;
    updates.sent_to_name = invoice.customer_name || null;
  }

  const { error: updateErr } = await supabase
    .from('invoices')
    .update(updates)
    .eq('id', invoice.id);
  if (updateErr) throw updateErr;

  try {
    await writeAudit({
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'status_changed_manually',
      before: { status: invoice.status },
      after: { status: nextStatus },
      source: 'user',
      userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  if (invoice.status === 'draft' && nextStatus === 'sent') {
    try {
      await posting.postInvoiceSent(invoice, { userId: req.session.userId });
    } catch (e) {
      console.error('JE post failed (invoice manual status) - continuing:', e.message);
    }
  }

  setFlash(req, 'success', `${invoice.display_number} status changed to ${nextStatus.replace(/_/g, ' ')}.`);
  res.redirect(`/invoices/${invoice.id}`);
});

// GET /:id/csv — download invoice as QuickBooks-compatible CSV
router.get('/:id/csv', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });

  const invNum = invoice.display_number;
  const custName = invoice.customer_name || 'Unknown';

  // Format dates as M/D/YYYY for QuickBooks
  const invDate = invoice.created_at ? new Date(invoice.created_at).toLocaleDateString('en-US') : '';
  const dueDate = invoice.due_date ? new Date(invoice.due_date + 'T00:00:00').toLocaleDateString('en-US') : '';

  const terms = invoice.payment_terms || '';
  const email = invoice.customer_billing_email || invoice.customer_email || '';
  const poNum = invoice.po_number || '';
  const isTaxable = Number(invoice.tax_rate || 0) > 0;
  const taxable = isTaxable ? 'Y' : 'N';
  const taxCode = isTaxable ? 'TAX' : 'NON';

  // Build CSV rows
  const lines = (invoice.lines || []).length > 0 ? invoice.lines : [{ description: invoice.description || 'Invoice', quantity: 1, unit_price: invoice.total, line_total: invoice.total }];

  let csv = 'Invoice No,Customer Name,Invoice Date,Due Date,Terms,Service Date,Product/Service,Item Description,Item Quantity,Item Rate,Item Amount,Taxable,Item Tax Code,Memo,Email,PO Number\n';

  lines.forEach(li => {
    const desc = (li.description || '').replace(/"/g, '""');
    const item = 'Recon Services';
    const memo = (invoice.notes || '').replace(/"/g, '""');
    csv += `"${invNum}","${custName}","${invDate}","${dueDate}","${terms}","","${item}","${desc}",${li.quantity || 1},${li.unit_price || 0},${li.line_total || 0},"${taxable}","${taxCode}","${memo}","${email}","${poNum}"\n`;
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${invNum}-${dateStr}.csv"`);
  res.send(csv);
});

router.post('/:id/mark-paid', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: invoice, error: findErr } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (!['sent', 'overdue'].includes(invoice.status)) {
    setFlash(req, 'error', `Cannot mark paid from status "${invoice.status}".`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  let amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) amount = Number(invoice.total) || 0;
  // Cap at remaining balance
  const remaining = Number(invoice.total) - (Number(invoice.amount_paid) || 0);
  if (amount > remaining) amount = remaining;

  // RPC: record_payment handles status flip + paid_at + audit row
  const paymentDate = new Date().toISOString().slice(0, 10);
  const { error: rpcErr } = await supabase.rpc('record_payment', {
    invoice_id: id,
    amount,
    payment_date: paymentDate,
    user_id: req.currentUser?.id ?? req.session?.userId ?? null,
  });
  if (rpcErr) throw rpcErr;

  // Post payment JE: DR Cash / CR AR
  try {
    if (amount > 0) {
      await posting.postPaymentReceived(invoice, amount, { userId: req.session.userId });
    }
  } catch (e) {
    console.error('JE post failed (payment) — continuing:', e.message);
  }

  const isFullyPaid = amount >= remaining;
  if (isFullyPaid) {
    setFlash(req, 'success', `Invoice marked paid in full.`);
  } else {
    const newBalance = Number(invoice.total) - (Number(invoice.amount_paid) || 0) - amount;
    setFlash(req, 'success', `Partial payment $${amount.toFixed(2)} recorded. Balance: $${newBalance.toFixed(2)}.`);
  }
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/:id/billing-complete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: invoice, error: findErr } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (!['sent', 'overdue', 'paid'].includes(invoice.status)) {
    setFlash(req, 'error', `Cannot mark billing complete from status "${invoice.status}".`);
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ status: 'billing_complete', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateErr) throw updateErr;

  try {
    await writeAudit({
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'billing_complete',
      before: { status: invoice.status },
      after: { status: 'billing_complete' },
      source: 'user',
      userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `Invoice marked billing complete.`);
  res.redirect(`/invoices/${invoice.id}`);
});


router.post('/:id/reopen-billing', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: invoice, error: findErr } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status !== 'billing_complete') {
    setFlash(req, 'error', `Cannot reopen billing from status "${invoice.status}".`);
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ status: 'sent', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateErr) throw updateErr;

  try {
    await writeAudit({
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'billing_reopened',
      before: { status: invoice.status },
      after: { status: 'sent' },
      source: 'user',
      userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `Invoice billing reopened.`);
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/:id/void', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: invoice, error: findErr } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status === 'paid') {
    setFlash(req, 'error', `Cannot void a paid invoice.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }

  // RPC: void_invoice handles status + audit row
  const { error: rpcErr } = await supabase.rpc('void_invoice', {
    invoice_id: id,
    user_id: req.currentUser?.id ?? req.session?.userId ?? null,
  });
  if (rpcErr) throw rpcErr;

  // Reverse the original send JE if one exists
  try {
    const { data: fullInv } = await supabase.from('invoices').select('*').eq('id', id).maybeSingle();
    if (fullInv) await posting.postInvoiceVoid(fullInv, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (void) — continuing:', e.message);
  }

  setFlash(req, 'success', `Invoice voided.`);
  res.redirect(`/invoices/${invoice.id}`);
});

router.get('/:id/pdf', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  const company = await loadCompanySettings();
  const filename = `${invoice.display_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    pdf.generateInvoicePDF({ ...customerFacingInvoice(invoice), invoice_number: invoice.display_number }, company, res);
  } catch (err) {
    console.error('Invoice PDF failed:', err);
    if (!res.headersSent) res.status(500).render('error', { title: 'PDF error', code: 500, message: err.message });
    else res.end();
  }
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: invoice, error: findErr } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status !== 'void') {
    setFlash(req, 'error', `Cannot delete invoice in status "${invoice.status}". Void it first.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  const { error: delLineErr } = await supabase.from('invoice_line_items').delete().eq('invoice_id', id);
  if (delLineErr) throw delLineErr;
  const { error: delErr } = await supabase.from('invoices').delete().eq('id', id);
  if (delErr) throw delErr;

  try {
    await writeAudit({
      entityType: 'invoice', entityId: id, action: 'delete',
      before: { status: invoice.status }, after: null,
      source: 'user', userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `Invoice deleted.`);
  res.redirect('/invoices');
});

module.exports = router;
