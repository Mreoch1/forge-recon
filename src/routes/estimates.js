/**
 * Estimates CRUD (v0.5).
 *
 * Created via POST /work-orders/:id/create-estimate (1:1 with WO).
 * Display number = WO's display number, prefixed EST-.
 *
 *   GET   /                    list
 *   GET   /:id                 show
 *   GET   /:id/edit            edit (draft only)
 *   POST  /:id                 update
 *   POST  /:id/send            draft -> sent (PDF emailed to customer.email)
 *   POST  /:id/accept          sent -> accepted
 *   POST  /:id/reject          sent -> rejected
 *   POST  /:id/generate-invoice  accepted -> creates invoice with selected lines
 *   GET   /:id/pdf             PDF
 *   POST  /:id/delete          delete (only when no invoice references it)
 *
 * Line item `selected` flag: customer can accept only some lines. Only
 * selected lines copy to the invoice on generate-invoice.
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');
const email = require('../services/email');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'];
const VALID_UNITS = ['ea', 'hr', 'sqft', 'lf', 'ton', 'lot'];

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

function validateLineItem(li) {
  const description = emptyToNull(li.description);
  const unit = emptyToNull(li.unit) || 'ea';
  const quantity = parseFloat(li.quantity);
  const unitPrice = parseFloat(li.unit_price);
  const cost = parseFloat(li.cost);
  const selected = 1; // Always default to selected; line selection happens at invoice time
  return {
    data: {
      description,
      quantity: isFinite(quantity) && quantity >= 0 ? quantity : 0,
      unit: VALID_UNITS.includes(unit) ? unit : 'ea',
      unit_price: isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      cost: isFinite(cost) && cost >= 0 ? cost : 0,
      selected,
    }
  };
}

function validateEstimate(body) {
  const errors = {};
  const validUntil = emptyToNull(body.valid_until);
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) errors.valid_until = 'Use YYYY-MM-DD.';
  const taxRate = parseFloat(body.tax_rate);
  const taxRateNum = isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;
  const notes = emptyToNull(body.notes);

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    if (!emptyToNull(li.description)) return;
    items.push(validateLineItem(li).data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';

  return { errors, data: { valid_until: validUntil, tax_rate: taxRateNum, notes, lines: items } };
}

async function loadEstimate(id) {
  const { data: est, error } = await supabase
    .from('estimates')
    .select(`
      *,
      work_orders!left(
        id, display_number, wo_number_main, wo_number_sub, customer_id, unit_number,
        customers!left(id, name, email, billing_email, phone, address, city, state, zip),
        jobs!left(id, title, address, city, state, zip,
          customers!left(id, name, email, billing_email, phone, address, city, state, zip))
      )
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!est) return null;
  // Flatten nested data
  const w = est.work_orders;
  const j = w?.jobs;
  const c = w?.customers || j?.customers;
  est.wo_id = w?.id;
  est.wo_display_number = w?.display_number;
  est.wo_number_main = w?.wo_number_main;
  est.wo_number_sub = w?.wo_number_sub;
  est.job_id = j?.id;
  est.job_title = j?.title || (c?.name ? `${c.name} work order` : 'Customer work order');
  est.job_address = j?.address;
  est.job_city = j?.city;
  est.job_state = j?.state;
  est.job_zip = j?.zip;
  est.customer_id = c?.id;
  est.customer_name = c?.name;
  est.customer_email = c?.email;
  est.customer_billing_email = c?.billing_email;
  est.customer_phone = c?.phone;
  est.customer_address = c?.address;
  est.customer_city = c?.city;
  est.customer_state = c?.state;
  est.customer_zip = c?.zip;
  delete est.work_orders;
  if (est.sent_by_user_id) {
    const { data: sentBy } = await supabase
      .from('users')
      .select('name')
      .eq('id', est.sent_by_user_id)
      .maybeSingle();
    est.sent_by_name = sentBy?.name || null;
  }
  // Load line items
  const { data: lines } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', id)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  est.lines = lines || [];
  est.display_number = `EST-${est.wo_display_number}`;
  return est;
}

router.get('/', async (req, res) => {
  // F4: sanitize before interpolating into PostgREST .or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const status = (req.query.status || '').trim();
  const archiveFilter = (req.query.archived || '0');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase.from('estimates').select(`
    id, status, total, cost_total, valid_until, created_at,
    work_orders!left(
      display_number, id, customer_id,
      customers!left(id, name),
      jobs!left(id, title, customers!left(id, name))
    )
  `, { count: 'exact', head: false });
  let countQuery = supabase.from('estimates').select('*', { count: 'exact', head: true });

  if (q) {
    // Nested relation filters can break when WOs no longer require jobs.
    // Keep the database query broad and apply the mixed customer/legacy search below.
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
    countQuery = countQuery.eq('status', status);
  }
  if (archiveFilter === '0') {
    query = query.is('archived_at', null);
    countQuery = countQuery.is('archived_at', null);
  } else if (archiveFilter === '1') {
    query = query.not('archived_at', 'is', null);
    countQuery = countQuery.not('archived_at', 'is', null);
  }

  const [{ data: estimates, count: total }, { error }] = await Promise.all([
    query.order('created_at', { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (error) throw error;

  const filtered = q
    ? (estimates || []).filter(r => {
        const haystack = [
          r.work_orders?.display_number,
          r.work_orders?.customers?.name,
          r.work_orders?.jobs?.title,
          r.work_orders?.jobs?.customers?.name,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q.toLowerCase());
      })
    : (estimates || []);

  const mapped = filtered.map(r => ({
    id: r.id, status: r.status, total: r.total, cost_total: r.cost_total,
    valid_until: r.valid_until, created_at: r.created_at,
    wo_display_number: r.work_orders?.display_number,
    wo_id: r.work_orders?.id,
    job_id: r.work_orders?.jobs?.id,
    job_title: r.work_orders?.jobs?.title || (r.work_orders?.customers?.name ? `${r.work_orders.customers.name} work order` : 'Customer work order'),
    customer_id: r.work_orders?.customers?.id || r.work_orders?.jobs?.customers?.id,
    customer_name: r.work_orders?.customers?.name || r.work_orders?.jobs?.customers?.name,
  }));

  res.render('estimates/index', {
    title: 'Estimates', activeNav: 'estimates',
    estimates: mapped, q, status, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES, canSeePrices: true,
    archiveFilter,
  });
});

router.get('/:id', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const { data: invoice } = await supabase.from('invoices').select('id, status').eq('estimate_id', estimate.id).maybeSingle();
  res.render('estimates/show', {
    title: estimate.display_number, activeNav: 'estimates',
    estimate, invoice, canSeePrices: true
  });
});

router.get('/:id/edit', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (estimate.status !== 'draft') {
    setFlash(req, 'error', `Estimate ${estimate.display_number} is "${estimate.status}" — cannot edit.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  res.render('estimates/edit', {
    title: `Edit ${estimate.display_number}`, activeNav: 'estimates',
    estimate, errors: {}, units: VALID_UNITS
  });
});

router.post('/:id', async (req, res) => {
  const existing = await loadEstimate(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (existing.status !== 'draft') {
    setFlash(req, 'error', `Estimate ${existing.display_number} is "${existing.status}" — cannot edit.`);
    return res.redirect(`/estimates/${existing.id}`);
  }
  const { errors, data } = validateEstimate(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('estimates/edit', {
      title: `Edit ${existing.display_number}`, activeNav: 'estimates',
      estimate: { ...existing, ...data }, errors, units: VALID_UNITS
    });
  }
  const t = calc.totals(data.lines, data.tax_rate);
  const costTotal = data.lines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);
  const { error: rpcError } = await supabase.rpc('update_estimate_with_lines', {
    estimate_id: existing.id,
    estimate_data: {
      work_order_id: existing.wo_id,
      subtotal: t.subtotal, tax_rate: data.tax_rate, tax_amount: t.taxAmount,
      total: t.total, cost_total: costTotal, status: 'draft',
    },
    lines: data.lines.map((li, idx) => ({
      ...li, line_total: calc.lineTotal(li), sort_order: idx, selected: 1,
    })),
  });
  if (rpcError) throw rpcError;
  setFlash(req, 'success', `${existing.display_number} updated.`);
  res.redirect(`/estimates/${existing.id}`);
});

async function statusTransition(req, res, fromStatus, toStatus, timestampField) {
  const est = await loadEstimate(req.params.id);
  if (!est) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(est.status)) {
    setFlash(req, 'error', `Cannot move ${est.display_number} from "${est.status}" to "${toStatus}".`);
    return res.redirect(`/estimates/${est.id}`);
  }
  const sets = ['status = ?', `updated_at = now()`];
  const params = [toStatus];
  if (timestampField) sets.push(`${timestampField} = now()`);
  await supabase.from('estimates').update({
    status: toStatus,
    updated_at: new Date().toISOString(),
    ...(timestampField ? { [timestampField]: new Date().toISOString() } : {}),
  }).eq('id', est.id);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'estimate', entityId: est.id, action: toStatus, before: { status: est.status }, after: { status: toStatus }, source: 'user', userId: req.session.userId });
  } catch(e) { console.error('audit failed:', e.message); }
  setFlash(req, 'success', `${est.display_number} marked ${toStatus}.`);
  res.redirect(`/estimates/${est.id}`);
}

// Send: generate PDF, write .eml to mail-outbox/, transition draft -> sent
router.post('/:id/send', async (req, res, next) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (estimate.status !== 'draft') {
    setFlash(req, 'error', `${estimate.display_number} is "${estimate.status}" — already sent.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  try {
    const emailService = require('../services/estimate-email');
    const result = await emailService.sendEstimateEmail(estimate.id);
    const sentToEmail = estimate.customer_email || 'unknown@recon.local';
    const sentToName = estimate.customer_name || 'Unknown';
    await supabase.from('estimates').update({
      status: 'sent', sent_at: new Date().toISOString(),
      sent_by_user_id: req.session.userId, sent_to_email: sentToEmail,
      sent_to_name: sentToName, updated_at: new Date().toISOString(),
    }).eq('id', estimate.id);
    try {
      const { writeAudit } = require('../services/audit');
      writeAudit({ entityType: 'estimate', entityId: estimate.id, action: 'sent', before: { status: 'draft' }, after: { status: 'sent' }, source: 'user', userId: req.session.userId });
    } catch(e) { console.error('audit failed:', e.message); }
    const note = result.mode === 'file' && result.filepath ? ` Email saved to ${result.filepath}.` : '';
    setFlash(req, 'success', `${estimate.display_number} sent.${note}`);
    res.redirect(`/estimates/${estimate.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/accept', (req, res) => statusTransition(req, res, 'sent', 'accepted', 'accepted_at'));
router.post('/:id/reject', (req, res) => statusTransition(req, res, 'sent', 'rejected', null));

// Archive / close
router.post('/:id/archive', async (req, res) => {
  const est = await loadEstimate(req.params.id);
  if (!est) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (est.archived_at) {
    setFlash(req, 'info', `${est.display_number} is already archived.`);
    return res.redirect(`/estimates/${est.id}`);
  }
  let newStatus = est.status;
  if (est.status === 'draft' || est.status === 'sent') { newStatus = 'expired'; }
  await supabase.from('estimates').update({
    archived_at: new Date().toISOString(), status: newStatus, updated_at: new Date().toISOString(),
  }).eq('id', est.id);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'estimate', entityId: est.id, action: 'archived', before: { status: est.status }, after: { status: newStatus, archived_at: 'now' }, source: 'user', userId: req.session.userId });
  } catch(e) { console.error('audit failed:', e.message); }
  setFlash(req, 'success', `${est.display_number} archived.`);
  res.redirect('/estimates');
});

// Admin unarchive
router.post('/:id/unarchive', async (req, res) => {
  if (req.session.role !== 'admin') {
    setFlash(req, 'error', 'Only admins can unarchive estimates.');
    return res.redirect(`/estimates/${req.params.id}`);
  }
  const est = await loadEstimate(req.params.id);
  if (!est) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!est.archived_at) {
    setFlash(req, 'info', `${est.display_number} is not archived.`);
    return res.redirect(`/estimates/${est.id}`);
  }
  await supabase.from('estimates').update({
    archived_at: null, updated_at: new Date().toISOString(),
  }).eq('id', est.id);
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'estimate', entityId: est.id, action: 'unarchived', before: { archived_at: est.archived_at }, after: { archived_at: null }, source: 'user', userId: req.session.userId });
  } catch(e) { console.error('audit failed:', e.message); }
  setFlash(req, 'success', `${est.display_number} unarchived.`);
  res.redirect(`/estimates/${est.id}`);
});

// Generate invoice from accepted estimate — first redirects to line-selection page
router.post('/:id/generate-invoice', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Estimate must be sent or accepted before invoicing. Current: ${estimate.status}.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const { data: existingInv } = await supabase.from('invoices').select('id').eq('estimate_id', estimate.id).maybeSingle();
  if (existingInv) {
    setFlash(req, 'info', `Invoice already exists for ${estimate.display_number}.`);
    return res.redirect(`/invoices/${existingInv.id}`);
  }

  // If this is a form submission from select-for-invoice page with selected_lines
  const rawSelectedLines = req.body.selected_lines;
  if (rawSelectedLines !== undefined) {
    // Process selected lines
    const selectedLineIds = {};
    if (Array.isArray(rawSelectedLines)) {
      rawSelectedLines.forEach(id => { selectedLineIds[id] = true; });
    } else if (typeof rawSelectedLines === 'string') {
      selectedLineIds[rawSelectedLines] = true;
    } else if (typeof rawSelectedLines === 'object') {
      Object.keys(rawSelectedLines).forEach(k => { selectedLineIds[k] = true; });
    }

    const selectedLines = estimate.lines.filter(li => selectedLineIds[li.id]);
    if (selectedLines.length === 0) {
      setFlash(req, 'error', 'Select at least one line item to invoice.');
      return res.redirect(`/estimates/${estimate.id}/select-for-invoice`);
    }

    // Use convert_estimate_to_invoice RPC
    const { data: invResult, error: rpcErr } = await supabase.rpc('convert_estimate_to_invoice', {
      estimate_id: estimate.id,
      selected_line_ids: selectedLines.map(li => li.id),
    });
    if (rpcErr) throw rpcErr;

    setFlash(req, 'success', `INV-${estimate.wo_display_number} generated (${selectedLines.length} line items transferred).`);
    return res.redirect(`/invoices/${invResult}`);
  }

  // First-time click: redirect to select-for-invoice page
  res.redirect(`/estimates/${estimate.id}/select-for-invoice`);
});

// Select-for-invoice page — pick which lines to invoice
router.get('/:id/select-for-invoice', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Estimate must be sent or accepted. Current: ${estimate.status}.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const { data: existingInv } = await supabase.from('invoices').select('id').eq('estimate_id', estimate.id).maybeSingle();
  if (existingInv) {
    setFlash(req, 'info', `Invoice already exists.`);
    return res.redirect(`/invoices/${existingInv.id}`);
  }
  res.render('estimates/select-for-invoice', {
    title: `Select lines to invoice`, activeNav: 'estimates',
    estimate
  });
});

router.get('/:id/pdf', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const { data: company } = await supabase.from('company_settings').select('*').eq('id', 1).maybeSingle();
  const filename = `${estimate.display_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    pdf.generateEstimatePDF({ ...estimate, estimate_number: estimate.display_number }, company || {}, res);
  } catch (err) {
    console.error('Estimate PDF failed:', err);
    if (!res.headersSent) res.status(500).render('error', { title: 'PDF error', code: 500, message: err.message });
    else res.end();
  }
});

router.post('/:id/delete', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const { count: invCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('estimate_id', estimate.id);
  if (invCount) {
    setFlash(req, 'error', `Cannot delete ${estimate.display_number} — an invoice references it.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  await supabase.from('estimate_line_items').delete().eq('estimate_id', estimate.id);
  await supabase.from('estimates').delete().eq('id', estimate.id);
  setFlash(req, 'success', `${estimate.display_number} deleted.`);
  res.redirect('/estimates');
});

module.exports = router;
