/**
 * Invoices CRUD (v0.5).
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
const db = require('../db/db');
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
  // LEFT JOINs throughout so a missing reference can't 404 the whole row.
  // The unused `estimates` join is dropped — `i.estimate_id` (from i.*) is
  // already the FK value the view needs; we never aliased anything from
  // the estimates table that wasn't a duplicate.
  const inv = await db.get(
    `SELECT i.*,
            w.id AS wo_id, w.display_number AS wo_display_number,
            j.id AS job_id, j.title AS job_title,
            j.address AS job_address, j.city AS job_city, j.state AS job_state, j.zip AS job_zip,
            c.id AS customer_id, c.name AS customer_name,
            c.email AS customer_email, c.billing_email AS customer_billing_email,
            c.phone AS customer_phone,
            c.address AS customer_address, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip,
            u.name AS sent_by_name
     FROM invoices i
     LEFT JOIN work_orders w ON w.id = i.work_order_id
     LEFT JOIN jobs j        ON j.id = w.job_id
     LEFT JOIN customers c   ON c.id = j.customer_id
     LEFT JOIN users u       ON u.id = i.sent_by_user_id
     WHERE i.id = ?`,
    [id]
  );
  if (!inv) return null;
  inv.lines = await db.all(
    `SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  inv.display_number = `INV-${inv.wo_display_number || '????-????'}`;
  return inv;
}

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (q) {
    conds.push('(w.display_number ILIKE ? OR j.title ILIKE ? OR c.name ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    conds.push('i.status = ?');
    params.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (await db.get(
    `SELECT COUNT(*) AS n FROM invoices i
     JOIN work_orders w ON w.id = i.work_order_id
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id ${where}`,
    params
  ) || {}).n || 0;

  const invoices = await db.all(
    `SELECT i.id, i.status, i.total, i.amount_paid, i.due_date, i.created_at, i.payment_terms,
            w.id AS wo_id, w.display_number AS wo_display_number,
            j.id AS job_id, j.title AS job_title,
            c.id AS customer_id, c.name AS customer_name
     FROM invoices i
     JOIN work_orders w ON w.id = i.work_order_id
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('invoices/index', {
    title: 'Invoices', activeNav: 'invoices',
    invoices, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/:id', async (req, res) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  let displayStatus = invoice.status;
  if (invoice.status === 'sent' && invoice.due_date) {
    const dueAt = new Date(String(invoice.due_date).slice(0,10));
    if (!isNaN(dueAt.getTime()) && dueAt < new Date()) displayStatus = 'overdue';
  }
  res.render('invoices/show', {
    title: invoice.display_number, activeNav: 'invoices',
    invoice, displayStatus
  });
});

router.get('/:id/edit', async (req, res) => {
  const invoice = loadInvoice(req.params.id);
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
  const existing = loadInvoice(req.params.id);
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
  await db.transaction(async (tx) => {
    tx.run(
      `UPDATE invoices SET subtotal=?, tax_rate=?, tax_amount=?, total=?, cost_total=?,
                            payment_terms=?, due_date=?, notes=?, updated_at=now()
       WHERE id=?`,
      [t.subtotal, data.tax_rate, t.taxAmount, t.total, costTotal,
       data.payment_terms, data.due_date, data.notes, existing.id]
    );
    tx.run('DELETE FROM invoice_line_items WHERE invoice_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      tx.run(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price, cost, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [existing.id, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, idx]
      );
    });
  });
  setFlash(req, 'success', `${existing.display_number} updated.`);
  res.redirect(`/invoices/${existing.id}`);
});

router.post('/:id/send', async (req, res, next) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status !== 'draft') {
    setFlash(req, 'error', `${invoice.display_number} is "${invoice.status}" — already sent.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  try {
    const company = await db.get('SELECT * FROM company_settings WHERE id = 1') || {};
    const buf = await pdf.renderToBuffer(pdf.generateInvoicePDF, { ...invoice, invoice_number: invoice.display_number }, company);
    // Invoice goes to billing_email (falls back to email)
    const recipient = invoice.customer_billing_email || invoice.customer_email || 'unknown@recon.local';
    const subject = `Invoice ${invoice.display_number} from ${company.company_name || 'Recon Construction'}`;
    const dueLine = invoice.due_date ? `Due: ${String(invoice.due_date).slice(0,10)}` : '';
    const text = `Hello ${invoice.customer_name || ''},\n\nPlease find attached invoice ${invoice.display_number}.\nAmount: $${(Number(invoice.total)||0).toFixed(2)}\nTerms: ${invoice.payment_terms || 'Net 30'}\n${dueLine}\n\nThanks.\n${company.company_name || 'Recon Construction'}`;
    const sent = await email.sendEmail({
      to: recipient, subject, text,
      html: text.split('\n').map(l => `<p>${l}</p>`).join(''),
      attachments: [{ filename: `${invoice.display_number}.pdf`, content: buf, contentType: 'application/pdf' }]
    });
    await db.run(`UPDATE invoices SET status='sent', sent_at=now(), sent_by_user_id=?, sent_to_email=?, sent_to_name=?, updated_at=now() WHERE id=?`,
      [req.session.userId, recipient, invoice.customer_name || 'Unknown', invoice.id]);

    // Audit + post journal entry: DR AR / CR Revenue + Sales Tax
    writeAudit({
      entityType: 'invoice', entityId: invoice.id, action: 'send',
      before: { status: 'draft' }, after: { status: 'sent', recipient, sent_at: new Date().toISOString() },
      source: 'user', userId: req.session.userId,
    });
    try {
      posting.postInvoiceSent(invoice, { userId: req.session.userId });
    } catch (e) {
      console.error('JE post failed (invoice send) — continuing:', e.message);
    }

    const note = sent.mode === 'file' ? ` Email saved to ${sent.filepath}.` : '';
    setFlash(req, 'success', `${invoice.display_number} sent to ${recipient}.${note}`);
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/mark-paid', async (req, res) => {
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (!['sent', 'overdue'].includes(invoice.status)) {
    setFlash(req, 'error', `Cannot mark paid from status "${invoice.status}".`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  let amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) amount = Number(invoice.total) || 0;
  if (amount > Number(invoice.total)) amount = Number(invoice.total);
  const newStatus = (amount >= Number(invoice.total)) ? 'paid' : 'sent';
  const sets = ['amount_paid=?', `updated_at=now()`];
  const params = [amount];
  if (newStatus === 'paid') {
    sets.push('status=?', `paid_at=now()`);
    params.push(newStatus);
  }
  await db.run(`UPDATE invoices SET ${sets.join(', ')} WHERE id=?`, [...params, invoice.id]);

  // Audit + post payment JE: DR Cash / CR AR
  const newPaymentAmt = amount - (Number(invoice.amount_paid) || 0);
  writeAudit({
    entityType: 'invoice', entityId: invoice.id, action: 'payment',
    before: { status: invoice.status, amount_paid: invoice.amount_paid },
    after: { status: newStatus, amount_paid: amount, payment_recorded: newPaymentAmt },
    source: 'user', userId: req.session.userId,
  });
  try {
    if (newPaymentAmt > 0) {
      posting.postPaymentReceived(invoice, newPaymentAmt, { userId: req.session.userId });
    }
  } catch (e) {
    console.error('JE post failed (payment) — continuing:', e.message);
  }

  if (newStatus === 'paid') {
    setFlash(req, 'success', `Invoice marked paid in full.`);
  } else {
    setFlash(req, 'success', `Partial payment $${amount.toFixed(2)} recorded. Balance: $${(invoice.total - amount).toFixed(2)}.`);
  }
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/:id/void', async (req, res) => {
  const invoice = await db.get('SELECT id, status FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (invoice.status === 'paid') {
    setFlash(req, 'error', `Cannot void a paid invoice.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  await db.run(`UPDATE invoices SET status='void', updated_at=now() WHERE id=?`, [invoice.id]);

  writeAudit({
    entityType: 'invoice', entityId: invoice.id, action: 'void',
    before: { status: invoice.status }, after: { status: 'void' },
    source: 'user', userId: req.session.userId,
  });
  try {
    // Reverse the original send JE if one exists
    const fullInv = await db.get('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
    if (fullInv) posting.postInvoiceVoid(fullInv, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (void) — continuing:', e.message);
  }

  setFlash(req, 'success', `Invoice voided.`);
  res.redirect(`/invoices/${invoice.id}`);
});

router.get('/:id/pdf', async (req, res) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  const company = await db.get('SELECT * FROM company_settings WHERE id = 1') || {};
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
  const invoice = await db.get('SELECT id, status FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  if (!['draft', 'void'].includes(invoice.status)) {
    setFlash(req, 'error', `Cannot delete invoice in status "${invoice.status}". Void it first.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  await db.run('DELETE FROM invoice_line_items WHERE invoice_id = ?', [invoice.id]);
  await db.run('DELETE FROM invoices WHERE id = ?', [invoice.id]);
  setFlash(req, 'success', `Invoice deleted.`);
  res.redirect('/invoices');
});

module.exports = router;
