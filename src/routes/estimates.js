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
 *   GET   /:id/create-invoice  review approved lines before creating invoice
 *   POST  /:id/create-invoice  save approvals, then review invoice source
 *   POST  /:id/generate-invoice  accepted -> creates invoice with approved lines
 *   GET   /:id/pdf             PDF
 *   POST  /:id/delete          delete (only when no invoice references it)
 *
 * Line item `selected` flag: customer can approve only some lines. Only
 * approved lines copy to the invoice on generate-invoice.
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');
const email = require('../services/email');
const posting = require('../services/accounting-posting');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'];
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

function isLineApproved(line) {
  return !(line.selected === 0 || line.selected === false || line.selected === '0');
}

function idSetFromFormValue(value) {
  const ids = new Set();
  if (Array.isArray(value)) value.forEach(id => ids.add(String(id)));
  else if (typeof value === 'string') ids.add(value);
  else if (typeof value === 'number') ids.add(String(value));
  else if (value && typeof value === 'object') {
    Object.keys(value).forEach(id => ids.add(String(id)));
    Object.values(value).forEach(id => ids.add(String(id)));
  }
  return ids;
}

async function saveApprovalForm(estimate, approvedLinesValue) {
  const approvedIds = idSetFromFormValue(approvedLinesValue);
  const updates = await Promise.all((estimate.lines || []).map(li => supabase
    .from('estimate_line_items')
    .update({ selected: approvedIds.has(String(li.id)) ? 1 : 0 })
    .eq('id', li.id)
    .eq('estimate_id', estimate.id)
  ));
  const updateError = updates.find(result => result.error)?.error;
  if (updateError) throw updateError;
  return approvedIds;
}

function approvedInvoiceLines(estimate) {
  return (estimate.lines || []).filter(isLineApproved);
}

function invoicePreviewTotals(lines, taxRate) {
  const subtotal = lines.reduce((sum, li) => sum + (Number(li.line_total) || 0), 0);
  const rate = Number(taxRate) || 0;
  const taxAmount = subtotal * rate / 100;
  return { subtotal, taxRate: rate, taxAmount, total: subtotal + taxAmount };
}

function paymentTermsFromBody(body, fallback = 'Net 30') {
  const selected = emptyToNull(body.payment_terms);
  if (selected === '__custom') return emptyToNull(body.payment_terms_custom) || fallback;
  return selected || fallback;
}

function missingPostgrestColumn(error) {
  const message = String(error?.message || '');
  const quoted = message.match(/'([^']+)' column/);
  if (quoted) return quoted[1];
  const bare = message.match(/column\s+([a-zA-Z0-9_]+)/);
  return bare ? bare[1] : null;
}

async function updateEstimate(id, payload, options = {}) {
  const optionalFields = options.optionalFields || [];
  const { error } = await supabase.from('estimates').update(payload).eq('id', id);
  if (!error) return;

  const missing = missingPostgrestColumn(error);
  if (error.code === 'PGRST204' && missing && optionalFields.includes(missing)) {
    const reducedPayload = { ...payload };
    for (const field of optionalFields) delete reducedPayload[field];
    const { error: retryError } = await supabase.from('estimates').update(reducedPayload).eq('id', id);
    if (retryError) throw retryError;
    console.warn(`[estimates] optional columns missing; saved core update without ${optionalFields.join(', ')}: ${error.message}`);
    return;
  }

  throw error;
}

function validateLineItem(li) {
  const description = emptyToNull(li.description);
  const unit = emptyToNull(li.unit) || 'ea';
  const quantity = parseFloat(li.quantity);
  const unitPrice = parseFloat(li.unit_price);
  const cost = parseFloat(li.cost);
  const selectedInput = Array.isArray(li.selected) ? li.selected[li.selected.length - 1] : li.selected;
  const selected = selectedInput === '1' || selectedInput === 1 || selectedInput === true || selectedInput === 'on' ? 1 : 0;
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
  const paymentTerms = paymentTermsFromBody(body);
  const notes = emptyToNull(body.notes);

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    if (!emptyToNull(li.description)) return;
    items.push(validateLineItem(li).data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';

  return { errors, data: { valid_until: validUntil, tax_rate: taxRateNum, payment_terms: paymentTerms, notes, lines: items } };
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
    estimate, errors: {}, units: VALID_UNITS, paymentTermsPresets: PAYMENT_TERMS_PRESETS
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
      estimate: { ...existing, ...data }, errors, units: VALID_UNITS,
      paymentTermsPresets: PAYMENT_TERMS_PRESETS
    });
  }
  const t = calc.totals(data.lines, data.tax_rate);
  const costTotal = data.lines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);
  const { error: rpcError } = await supabase.rpc('update_estimate_with_lines', {
    p_estimate_id: existing.id,
    estimate_data: {
      work_order_id: existing.wo_id,
      subtotal: t.subtotal, tax_rate: data.tax_rate, tax_amount: t.taxAmount,
      total: t.total, cost_total: costTotal, payment_terms: data.payment_terms, status: 'draft',
    },
    lines: data.lines.map((li, idx) => ({
      ...li, line_total: calc.lineTotal(li), sort_order: idx,
    })),
  });
  if (rpcError) throw rpcError;
  const { error: termsError } = await supabase
    .from('estimates')
    .update({ payment_terms: data.payment_terms, updated_at: new Date().toISOString() })
    .eq('id', existing.id);
  if (termsError && termsError.code !== '42703' && !String(termsError.message || '').includes('payment_terms')) throw termsError;
  if (termsError) console.warn('[estimates] payment_terms column missing; estimate terms were not persisted:', termsError.message);
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
  const { error: statusErr } = await supabase.from('estimates').update({
    status: toStatus,
    updated_at: new Date().toISOString(),
    ...(timestampField ? { [timestampField]: new Date().toISOString() } : {}),
  }).eq('id', est.id);
  if (statusErr) throw statusErr;
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
    const sentToEmail = result.to || estimate.customer_billing_email || estimate.customer_email;
    const sentToName = result.toName || estimate.customer_name || 'Unknown';
    await updateEstimate(estimate.id, {
      status: 'sent', sent_at: new Date().toISOString(),
      sent_by_user_id: req.session.userId, sent_to_email: sentToEmail,
      sent_to_name: sentToName, updated_at: new Date().toISOString(),
    }, { optionalFields: ['sent_to_email', 'sent_to_name'] });
    try {
      const { writeAudit } = require('../services/audit');
      writeAudit({ entityType: 'estimate', entityId: estimate.id, action: 'sent', before: { status: 'draft' }, after: { status: 'sent' }, source: 'user', userId: req.session.userId });
    } catch(e) { console.error('audit failed:', e.message); }
    const note = result.mode === 'file' && result.filepath ? ` Email saved to ${result.filepath}.` : '';
    setFlash(req, 'success', `${estimate.display_number} sent.${note}`);
    res.redirect(`/estimates/${estimate.id}`);
  } catch (err) { next(err); }
});

// R37l: Mark sent manually — flips draft→sent WITHOUT firing the email.
// Use when the customer was emailed/printed/delivered outside FORGE and you
// just need to record that this estimate has gone out so it can move to
// accepted/rejected later.
router.post('/:id/mark-sent', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (estimate.status !== 'draft') {
    setFlash(req, 'error', `${estimate.display_number} is "${estimate.status}" — already marked sent.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const recipient = estimate.customer_email || estimate.customer_billing_email || null;
  const now = new Date().toISOString();
  await updateEstimate(estimate.id, {
    status: 'sent',
    sent_at: now,
    sent_by_user_id: req.session.userId,
    sent_to_email: recipient,
    sent_to_name: estimate.customer_name || null,
    updated_at: now,
  }, { optionalFields: ['sent_to_email', 'sent_to_name'] });
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({
      entityType: 'estimate', entityId: estimate.id,
      action: 'marked_sent_manually',
      before: { status: 'draft' },
      after: { status: 'sent', sent_at: now },
      source: 'user',
      userId: req.session.userId,
    });
  } catch(e) { console.error('audit failed:', e.message); }
  setFlash(req, 'success', `${estimate.display_number} marked as sent (no email fired).`);
  res.redirect(`/estimates/${estimate.id}`);
});

router.post('/:id/accept', (req, res) => statusTransition(req, res, 'sent', 'accepted', 'accepted_at'));
router.post('/:id/reject', (req, res) => statusTransition(req, res, 'sent', 'rejected', null));

router.post('/:id/line-approvals', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['draft', 'sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Cannot change approved items while estimate is "${estimate.status}".`);
    return res.redirect(`/estimates/${estimate.id}`);
  }

  const approvedIds = await saveApprovalForm(estimate, req.body.approved_lines);

  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({
      entityType: 'estimate',
      entityId: estimate.id,
      action: 'line_approvals_updated',
      before: null,
      after: { approved_line_ids: Array.from(approvedIds) },
      source: 'user',
      userId: req.session.userId,
    });
  } catch(e) { console.error('audit failed:', e.message); }

  setFlash(req, 'success', 'Approved estimate items updated.');
  res.redirect(`/estimates/${estimate.id}`);
});

router.post('/:id/create-invoice', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['draft', 'sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Estimate must be draft, sent, or accepted before invoicing. Current: ${estimate.status}.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  if (req.body.approval_form === '1') {
    await saveApprovalForm(estimate, req.body.approved_lines);
  }
  return res.redirect(`/estimates/${estimate.id}/create-invoice`);
});

router.get('/:id/create-invoice', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['draft', 'sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Estimate must be draft, sent, or accepted before invoicing. Current: ${estimate.status}.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const { data: existingInv } = await supabase.from('invoices').select('id').eq('estimate_id', estimate.id).maybeSingle();
  if (existingInv) {
    setFlash(req, 'info', `Invoice already exists for ${estimate.display_number}.`);
    return res.redirect(`/invoices/${existingInv.id}`);
  }
  const approvedLines = approvedInvoiceLines(estimate);
  if (approvedLines.length === 0) {
    setFlash(req, 'error', 'Approve at least one estimate item before creating an invoice.');
    return res.redirect(`/estimates/${estimate.id}`);
  }
  res.render('estimates/create-invoice', {
    title: `Create invoice from ${estimate.display_number}`,
    activeNav: 'estimates',
    estimate,
    approvedLines,
    totals: invoicePreviewTotals(approvedLines, estimate.tax_rate),
  });
});

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
  const { error: archiveErr } = await supabase.from('estimates').update({
    archived_at: new Date().toISOString(), status: newStatus, updated_at: new Date().toISOString(),
  }).eq('id', est.id);
  if (archiveErr) throw archiveErr;
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
  const { error: unarchiveErr } = await supabase.from('estimates').update({
    archived_at: null, updated_at: new Date().toISOString(),
  }).eq('id', est.id);
  if (unarchiveErr) throw unarchiveErr;
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({ entityType: 'estimate', entityId: est.id, action: 'unarchived', before: { archived_at: est.archived_at }, after: { archived_at: null }, source: 'user', userId: req.session.userId });
  } catch(e) { console.error('audit failed:', e.message); }
  setFlash(req, 'success', `${est.display_number} unarchived.`);
  res.redirect(`/estimates/${est.id}`);
});

// Generate invoice from approved estimate items.
router.post('/:id/generate-invoice', async (req, res) => {
  const estimate = await loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['draft', 'sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Estimate must be draft, sent, or accepted before invoicing. Current: ${estimate.status}.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const { data: existingInv } = await supabase.from('invoices').select('id').eq('estimate_id', estimate.id).maybeSingle();
  if (existingInv) {
    setFlash(req, 'info', `Invoice already exists for ${estimate.display_number}.`);
    return res.redirect(`/invoices/${existingInv.id}`);
  }

  let approvedLines = estimate.lines.filter(isLineApproved);

  if (req.body.approval_form === '1') {
    const approvedIds = await saveApprovalForm(estimate, req.body.approved_lines);
    approvedLines = estimate.lines.filter(li => approvedIds.has(String(li.id)));
  }

  if (approvedLines.length === 0) {
    setFlash(req, 'error', 'Approve at least one estimate item before creating an invoice.');
    return res.redirect(`/estimates/${estimate.id}`);
  }

  // Legacy select-for-invoice submissions are still accepted, but they cannot
  // transfer lines that are not approved on the estimate.
  const rawSelectedLines = req.body.selected_lines;
  let selectedLines = approvedLines;
  if (rawSelectedLines !== undefined) {
    const selectedLineIds = idSetFromFormValue(rawSelectedLines);
    selectedLines = approvedLines.filter(li => selectedLineIds.has(String(li.id)));
    if (selectedLines.length === 0) {
      if (req.body.invoice_review === '1') {
        selectedLines = approvedLines;
      } else {
        setFlash(req, 'error', 'Select at least one approved item to invoice.');
        return res.redirect(`/estimates/${estimate.id}/create-invoice`);
      }
    }
  }

  const totals = invoicePreviewTotals(selectedLines, estimate.tax_rate);
  const costTotal = selectedLines.reduce((sum, li) => sum + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);
  const now = new Date().toISOString();

  // Load company settings for payment terms, conditions, etc.
  const { data: company } = await supabase.from('company_settings').select('*').limit(1).maybeSingle();
  const terms = estimate.payment_terms || company?.default_payment_terms || 'Net 30';
  // Calculate due date from terms
  let dueDate = null;
  const match = String(terms).match(/(\d+)/);
  if (match) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(match[1], 10));
    dueDate = d.toISOString().slice(0, 10);
  }
  const conditions = company?.default_conditions || null;
  // Load WO data for unit_number
  let woUnit = null;
  if (estimate.wo_id) {
    const { data: wo } = await supabase.from('work_orders').select('unit_number, description').eq('id', estimate.wo_id).maybeSingle();
    woUnit = wo?.unit_number || null;
  }

  const { data: invoice, error: invError } = await supabase.from('invoices').insert({
    estimate_id: estimate.id,
    work_order_id: estimate.wo_id,
    status: 'sent',
    subtotal: totals.subtotal,
    tax_rate: totals.taxRate,
    tax_amount: totals.taxAmount,
    total: totals.total,
    cost_total: costTotal,
    payment_terms: terms,
    due_date: dueDate,
    notes: estimate.notes || null,
    conditions: conditions,
    created_at: now,
    updated_at: now,
  }).select('id').single();
  if (invError) throw invError;

  const invResult = invoice.id;
  const { error: lineError } = await supabase.from('invoice_line_items').insert(selectedLines.map((li, idx) => ({
    invoice_id: invResult,
    description: li.description,
    quantity: li.quantity,
    unit: li.unit,
    unit_price: li.unit_price,
    cost: li.cost || 0,
    line_total: li.line_total,
    sort_order: idx,
  })));
  if (lineError) {
    const { error: cleanupLinesError } = await supabase.from('invoice_line_items').delete().eq('invoice_id', invResult);
    const { error: cleanupInvoiceError } = await supabase.from('invoices').delete().eq('id', invResult);
    if (cleanupLinesError || cleanupInvoiceError) {
      const cleanupError = new Error(`Invoice line insert failed and cleanup failed: ${cleanupLinesError?.message || cleanupInvoiceError?.message}`);
      cleanupError.cause = lineError;
      throw cleanupError;
    }
    throw lineError;
  }

  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({
      entityType: 'invoice',
      entityId: invResult,
      action: 'create_from_estimate',
      before: null,
      after: { estimate_id: estimate.id, line_count: selectedLines.length, total: totals.total },
      source: 'user',
      userId: req.session.userId,
    });
  } catch(e) { console.error('audit failed:', e.message); }

  try {
    await posting.postInvoiceSent({
      id: invResult,
      subtotal: totals.subtotal,
      tax_amount: totals.taxAmount,
      total: totals.total,
      display_number: `INV-${estimate.wo_display_number}`,
    }, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (invoice create) - continuing:', e.message);
  }

  const { error: estUpdateError } = await supabase.from('estimates').update({
    updated_at: now,
  }).eq('id', estimate.id);
  if (estUpdateError) console.warn('[estimates] invoice created but estimate timestamp update failed:', estUpdateError.message);

  // R37h: redirect to EDIT page so user lands on the editable form for tuning
  // (description, line items, terms) before clicking Send. Eliminates the
  // pre-send round-trip through /show → click Edit. GPT G-010 review caught
  // that the original redirect change was lost in commit d48b8e1 — re-applied.
  setFlash(req, 'success', `INV-${estimate.wo_display_number} created from ${selectedLines.length} approved item(s). Edit as needed and click Save.`);
  return res.redirect(`/invoices/${invResult}/edit`);
});

// Select-for-invoice page — pick which lines to invoice
router.get('/:id/select-for-invoice', async (req, res) => {
  res.redirect(`/estimates/${req.params.id}/create-invoice`);
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
  const { count: invCount, error: invCountError } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('estimate_id', estimate.id);
  if (invCountError) throw invCountError;
  if (invCount) {
    setFlash(req, 'error', `Cannot delete ${estimate.display_number} — an invoice references it.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const { error: lineDeleteErr } = await supabase.from('estimate_line_items').delete().eq('estimate_id', estimate.id);
  if (lineDeleteErr) throw lineDeleteErr;
  const { error: estimateDeleteErr } = await supabase.from('estimates').delete().eq('id', estimate.id);
  if (estimateDeleteErr) throw estimateDeleteErr;
  setFlash(req, 'success', `${estimate.display_number} deleted.`);
  res.redirect('/estimates');
});

module.exports = router;
