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
 *   GET   /:id/edit            edit (draft only)
 *   POST  /:id                 update
 *   POST  /:id/send            draft -> sent (PDF emailed to billing_email)
 *   POST  /:id/mark-paid       sent|overdue -> paid (or partial; stays sent)
 *   POST  /:id/void            any non-paid -> void
 *   GET   /:id/pdf             PDF
 *   POST  /:id/delete          draft or void only
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');
const email = require('../services/email');
const posting = require('../services/accounting-posting');
const { writeAudit } = require('../services/audit');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'];
const VALID_UNITS = ['ea', 'hr', 'sqft', 'lf', 'ton', 'lot'];
const PAYMENT_TERMS_PRESETS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Custom'];

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
  return {
    data: {
      description,
      quantity: isFinite(quantity) && quantity >= 0 ? quantity : 0,
      unit: VALID_UNITS.includes(unit) ? unit : 'ea',
      unit_price: isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      cost: isFinite(cost) && cost >= 0 ? cost : 0,
    }
  };
}

function validateInvoice(body) {
  const errors = {};
  const dueDate = emptyToNull(body.due_date);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors.due_date = 'Use YYYY-MM-DD.';
  const taxRate = parseFloat(body.tax_rate);
  const taxRateNum = isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;
  const paymentTerms = emptyToNull(body.payment_terms) || 'Net 30';
  const notes = emptyToNull(body.notes);

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    if (!emptyToNull(li.description)) return;
    items.push(validateLineItem(li).data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';

  return {
    errors,
    data: { due_date: dueDate, tax_rate: taxRateNum, payment_terms: paymentTerms, notes, lines: items }
  };
}

async function loadInvoice(id) {
  // Nested selects rely on FKs: invoices.work_order_id -> work_orders,
  // work_orders.job_id -> jobs, jobs.customer_id -> customers,
  // invoices.sent_by_user_id -> users.
  const { data: inv, error } = await supabase
    .from('invoices')
    .select(`
      *,
      work_orders!left(id, display_number, jobs!left(id, title, address, city, state, zip,
        customers!left(id, name, email, billing_email, phone, address, city, state, zip))),
      users!left(name)
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!inv) return null;

  // Flatten nested data to match view expectations
  const w = inv.work_orders;
  const j = w?.jobs;
  const c = j?.customers;
  inv.wo_id = w?.id;
  inv.wo_display_number = w?.display_number;
  inv.job_id = j?.id;
  inv.job_title = j?.title;
  inv.job_address = j?.address;
  inv.job_city = j?.city;
  inv.job_state = j?.state;
  inv.job_zip = j?.zip;
  inv.customer_id = c?.id;
  inv.customer_name = c?.name;
  inv.customer_email = c?.email;
  inv.customer_billing_email = c?.billing_email;
  inv.customer_phone = c?.phone;
  inv.customer_address = c?.address;
  inv.customer_city = c?.city;
  inv.customer_state = c?.state;
  inv.customer_zip = c?.zip;
  inv.sent_by_name = inv.users?.name;
  delete inv.work_orders;
  delete inv.users;

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
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('invoices')
    .select(`
      id, status, total, amount_paid, due_date, created_at, payment_terms,
      work_orders!left(id, display_number, jobs!left(id, title, customers!left(id, name)))
    `, { count: 'exact', head: false });

  if (q) {
    const like = `%${q}%`;
    query = query.or(
      `work_orders.display_number.ilike.${like},work_orders.jobs.title.ilike.${like},work_orders.jobs.customers.name.ilike.${like}`
    );
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  const { data: rows, count: total, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;

  const invoices = (rows || []).map(r => ({
    id: r.id, status: r.status, total: r.total, amount_paid: r.amount_paid,
    due_date: r.due_date, created_at: r.created_at, payment_terms: r.payment_terms,
    wo_id: r.work_orders?.id,
    wo_display_number: r.work_orders?.display_number,
    job_id: r.work_orders?.jobs?.id,
    job_title: r.work_orders?.jobs?.title,
    customer_id: r.work_orders?.jobs?.customers?.id,
    customer_name: r.work_orders?.jobs?.customers?.name,
  }));

  res.render('invoices/index', {
    title: 'Invoices', activeNav: 'invoices',
    invoices, q, status, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES
  });
});

router.get('/:id', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  let displayStatus = invoice.status;
  if (invoice.status === 'sent' && invoice.due_date) {
    const dueAt = new Date(String(invoice.due_date).slice(0, 10));
    if (!isNaN(dueAt.getTime()) && dueAt < new Date()) displayStatus = 'overdue';
  }
  res.render('invoices/show', {
    title: invoice.display_number, activeNav: 'invoices',
    invoice, displayStatus
  });
});

router.get('/:id/edit', async (req, res) => {
  const invoice = await loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status !== 'draft') {
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
  if (existing.status !== 'draft') {
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
    },
    lines: lineRows,
  });
  if (rpcErr) throw rpcErr;

  // RPC does not audit updates — write a separate audit row.
  try {
    const { error: auditErr } = await supabase.from('audit_logs').insert({
      entity_type: 'invoice',
      entity_id: existing.id,
      action: 'update',
      before_json: { total: existing.total },
      after_json: { total: t.total },
      source: 'web',
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
  if (invoice.status !== 'draft') {
    setFlash(req, 'error', `${invoice.display_number} is "${invoice.status}" — already sent.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  try {
    const company = await loadCompanySettings();
    const buf = await pdf.renderToBuffer(pdf.generateInvoicePDF, { ...invoice, invoice_number: invoice.display_number }, company);

    // Invoice goes to billing_email (falls back to email)
    const recipient = invoice.customer_billing_email || invoice.customer_email || 'unknown@recon.local';
    const subject = `Invoice ${invoice.display_number} from ${company.company_name || 'Recon Construction'}`;
    const dueLine = invoice.due_date ? `Due: ${String(invoice.due_date).slice(0, 10)}` : '';
    const text = `Hello ${invoice.customer_name || ''},\n\nPlease find attached invoice ${invoice.display_number}.\nAmount: $${(Number(invoice.total) || 0).toFixed(2)}\nTerms: ${invoice.payment_terms || 'Net 30'}\n${dueLine}\n\nThanks.\n${company.company_name || 'Recon Construction'}`;
    const sent = await email.sendEmail({
      to: recipient, subject, text,
      html: text.split('\n').map(l => `<p>${l}</p>`).join(''),
      attachments: [{ filename: `${invoice.display_number}.pdf`, content: buf, contentType: 'application/pdf' }]
    });

    const { error: updErr } = await supabase
      .from('invoices')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_by_user_id: req.session.userId,
        sent_to_email: recipient,
        sent_to_name: invoice.customer_name || 'Unknown',
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoice.id);
    if (updErr) throw updErr;

    // Audit
    try {
      await writeAudit({
        entityType: 'invoice', entityId: invoice.id, action: 'send',
        before: { status: 'draft' },
        after: { status: 'sent', recipient, sent_at: new Date().toISOString() },
        source: 'user', userId: req.session.userId,
      });
    } catch (e) { /* best-effort */ }

    // Post JE: DR AR / CR Revenue + Sales Tax
    try {
      await posting.postInvoiceSent(invoice, { userId: req.session.userId });
    } catch (e) {
      console.error('JE post failed (invoice send) — continuing:', e.message);
    }

    const note = sent.mode === 'file' ? ` Email saved to ${sent.filepath}.` : '';
    setFlash(req, 'success', `${invoice.display_number} sent to ${recipient}.${note}`);
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/mark-paid', async (req, res) => {
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

router.post('/:id/void', async (req, res) => {
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
    pdf.generateInvoicePDF({ ...invoice, invoice_number: invoice.display_number }, company, res);
  } catch (err) {
    console.error('Invoice PDF failed:', err);
    if (!res.headersSent) res.status(500).render('error', { title: 'PDF error', code: 500, message: err.message });
    else res.end();
  }
});

router.post('/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: invoice, error: findErr } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (!['draft', 'void'].includes(invoice.status)) {
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
