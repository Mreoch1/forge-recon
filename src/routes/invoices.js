/**
 * Invoices CRUD + status transitions + email-to-file send.
 *
 * Invoices are created from completed work orders via
 * POST /work-orders/:id/generate-invoice. There is no "create invoice
 * from scratch" route.
 *
 * Routes (mounted at /invoices, all gated by requireAuth):
 *   GET   /                  list with filters
 *   GET   /:id               show
 *   GET   /:id/edit          edit (only when status='draft')
 *   POST  /:id               update
 *   POST  /:id/send          draft -> sent. Generates PDF, writes .eml to mail-outbox/.
 *   POST  /:id/mark-paid     sent|overdue -> paid (with amount, defaults to total).
 *   POST  /:id/void          any -> void (terminal).
 *   GET   /:id/pdf           PDF (inline default, ?download=1 forces save)
 *   POST  /:id/delete        only when status in (draft, void).
 *
 * "overdue" is computed in the SHOW route (and visible to the user),
 * but stored status doesn't auto-flip yet — Phase 6+ adds a job for that.
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');
const email = require('../services/email');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'];
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
  const errors = {};
  const description = emptyToNull(li.description);
  if (!description) errors.description = 'Required.';
  const unit = emptyToNull(li.unit) || 'ea';
  if (!VALID_UNITS.includes(unit)) errors.unit = 'Invalid unit.';
  const quantity = parseFloat(li.quantity);
  if (!isFinite(quantity) || quantity < 0) errors.quantity = 'Must be ≥ 0.';
  const unitPrice = parseFloat(li.unit_price);
  if (!isFinite(unitPrice) || unitPrice < 0) errors.unit_price = 'Must be ≥ 0.';
  return { errors, data: { description, unit, quantity, unit_price: unitPrice } };
}

function validateInvoice(body) {
  const errors = {};

  const dueDate = emptyToNull(body.due_date);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    errors.due_date = 'Use YYYY-MM-DD.';
  }
  const taxRate = parseFloat(body.tax_rate);
  const taxRateNum = isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;
  const notes = emptyToNull(body.notes);

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    const isBlank = !emptyToNull(li.description) &&
      (!li.quantity || parseFloat(li.quantity) === 0) &&
      (!li.unit_price || parseFloat(li.unit_price) === 0);
    if (isBlank) return;
    items.push(validateLineItem(li).data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';

  return {
    errors,
    data: { due_date: dueDate, tax_rate: taxRateNum, notes, lines: items }
  };
}

function loadInvoice(id) {
  const inv = db.get(
    `SELECT i.*,
            j.title   AS job_title,
            j.address AS job_address,
            j.city    AS job_city,
            j.state   AS job_state,
            j.zip     AS job_zip,
            c.id      AS customer_id,
            c.name    AS customer_name,
            c.email   AS customer_email,
            c.phone   AS customer_phone,
            c.address AS customer_address,
            c.city    AS customer_city,
            c.state   AS customer_state,
            c.zip     AS customer_zip,
            w.wo_number AS wo_number
     FROM invoices i
     JOIN jobs j      ON j.id = i.job_id
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN work_orders w ON w.id = i.work_order_id
     WHERE i.id = ?`,
    [id]
  );
  if (!inv) return null;
  inv.lines = db.all(
    `SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  return inv;
}

// --- routes ---

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (q) {
    conds.push('(i.invoice_number LIKE ? OR j.title LIKE ? OR c.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    conds.push('i.status = ?');
    params.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (db.get(
    `SELECT COUNT(*) AS n
     FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN customers c ON c.id = j.customer_id ${where}`,
    params
  ) || {}).n || 0;

  const invoices = db.all(
    `SELECT i.id, i.invoice_number, i.status, i.total, i.amount_paid, i.due_date, i.created_at,
            j.id AS job_id, j.title AS job_title,
            c.id AS customer_id, c.name AS customer_name
     FROM invoices i
     JOIN jobs j ON j.id = i.job_id
     JOIN customers c ON c.id = j.customer_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('invoices/index', {
    title: 'Invoices',
    activeNav: 'invoices',
    invoices, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/:id', (req, res) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  // Display "overdue" badge if past due_date and not paid/void
  let displayStatus = invoice.status;
  if ((invoice.status === 'sent') && invoice.due_date) {
    const dueAt = new Date(String(invoice.due_date).slice(0,10));
    if (!isNaN(dueAt.getTime()) && dueAt < new Date()) displayStatus = 'overdue';
  }
  res.render('invoices/show', {
    title: invoice.invoice_number,
    activeNav: 'invoices',
    invoice, displayStatus
  });
});

router.get('/:id/edit', (req, res) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  if (invoice.status !== 'draft') {
    setFlash(req, 'error', `Invoice ${invoice.invoice_number} is "${invoice.status}" and cannot be edited.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  res.render('invoices/edit', {
    title: `Edit ${invoice.invoice_number}`,
    activeNav: 'invoices',
    invoice, errors: {}, units: VALID_UNITS
  });
});

router.post('/:id', (req, res) => {
  const existing = loadInvoice(req.params.id);
  if (!existing) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  if (existing.status !== 'draft') {
    setFlash(req, 'error', `Invoice ${existing.invoice_number} is "${existing.status}" and cannot be edited.`);
    return res.redirect(`/invoices/${existing.id}`);
  }

  const { errors, data } = validateInvoice(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('invoices/edit', {
      title: `Edit ${existing.invoice_number}`,
      activeNav: 'invoices',
      invoice: { ...existing, ...data },
      errors, units: VALID_UNITS
    });
  }

  const t = calc.totals(data.lines, data.tax_rate);
  db.transaction(() => {
    db.run(
      `UPDATE invoices
       SET subtotal=?, tax_rate=?, tax_amount=?, total=?, due_date=?, notes=?, updated_at=datetime('now')
       WHERE id=?`,
      [t.subtotal, data.tax_rate, t.taxAmount, t.total, data.due_date, data.notes, existing.id]
    );
    db.run('DELETE FROM invoice_line_items WHERE invoice_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [existing.id, li.description, li.quantity, li.unit, li.unit_price, lt, idx]
      );
    });
  });

  setFlash(req, 'success', `${existing.invoice_number} updated.`);
  res.redirect(`/invoices/${existing.id}`);
});

// --- send (with email-to-file) ---

router.post('/:id/send', async (req, res, next) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  if (invoice.status !== 'draft') {
    setFlash(req, 'error', `Invoice ${invoice.invoice_number} is "${invoice.status}" — already sent.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }

  try {
    const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
    const pdfBuffer = await pdf.renderToBuffer(pdf.generateInvoicePDF, invoice, company);

    const recipientEmail = invoice.customer_email || 'unknown@recon.local';
    const dueLine = invoice.due_date ? `Due: ${String(invoice.due_date).slice(0,10)}` : '';
    const text =
      `Hello ${invoice.customer_name || ''},\n\n` +
      `Please find attached invoice ${invoice.invoice_number}.\n` +
      `Amount: $${(Number(invoice.total) || 0).toFixed(2)}.\n` +
      `${dueLine}\n\n` +
      `Thank you.\n${company.company_name || 'Recon Construction'}`;
    const html =
      `<p>Hello ${invoice.customer_name || ''},</p>` +
      `<p>Please find attached invoice <strong>${invoice.invoice_number}</strong>.</p>` +
      `<p>Amount: <strong>$${(Number(invoice.total) || 0).toFixed(2)}</strong>.<br>` +
      (dueLine ? `${dueLine}` : '') +
      `</p><p>Thank you.<br>${company.company_name || 'Recon Construction'}</p>`;

    const sent = await email.sendEmail({
      to: recipientEmail,
      subject: `Invoice ${invoice.invoice_number} from ${company.company_name || 'Recon Construction'}`,
      text, html,
      attachments: [{
        filename: `${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });

    db.run(
      `UPDATE invoices SET status='sent', sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      [invoice.id]
    );

    const note = sent.mode === 'file'
      ? `Email saved to ${sent.filepath} (mock SMTP).`
      : `Email sent.`;
    setFlash(req, 'success', `${invoice.invoice_number} sent. ${note}`);
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    next(err);
  }
});

// --- mark-paid ---

router.post('/:id/mark-paid', (req, res) => {
  const invoice = db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  if (!['sent', 'overdue'].includes(invoice.status)) {
    setFlash(req, 'error', `Cannot mark ${invoice.invoice_number} paid from status "${invoice.status}".`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  let amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) amount = Number(invoice.total) || 0;
  if (amount > Number(invoice.total)) amount = Number(invoice.total);

  const newStatus = (amount >= Number(invoice.total)) ? 'paid' : 'sent';
  const sets = ['amount_paid=?', 'updated_at=datetime(\'now\')'];
  const params = [amount];
  if (newStatus === 'paid') {
    sets.push('status=?', 'paid_at=datetime(\'now\')');
    params.push(newStatus);
  }
  db.run(`UPDATE invoices SET ${sets.join(', ')} WHERE id=?`, [...params, invoice.id]);

  if (newStatus === 'paid') {
    setFlash(req, 'success', `${invoice.invoice_number} marked paid in full.`);
  } else {
    setFlash(req, 'success', `${invoice.invoice_number} partial payment recorded ($${amount.toFixed(2)}). Balance: $${(invoice.total - amount).toFixed(2)}.`);
  }
  res.redirect(`/invoices/${invoice.id}`);
});

router.post('/:id/void', (req, res) => {
  const invoice = db.get('SELECT id, invoice_number, status FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  if (invoice.status === 'paid') {
    setFlash(req, 'error', `Cannot void a paid invoice. Issue a credit memo manually.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  db.run(`UPDATE invoices SET status='void', updated_at=datetime('now') WHERE id=?`, [invoice.id]);
  setFlash(req, 'success', `${invoice.invoice_number} voided.`);
  res.redirect(`/invoices/${invoice.id}`);
});

// --- PDF ---

router.get('/:id/pdf', (req, res) => {
  const invoice = loadInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  const filename = `${invoice.invoice_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    pdf.generateInvoicePDF(invoice, company, res);
  } catch (err) {
    console.error('Invoice PDF generation failed:', err);
    if (!res.headersSent) {
      res.status(500).render('error', { title: 'PDF error', code: 500, message: 'PDF generation failed.' });
    } else {
      res.end();
    }
  }
});

// --- delete ---

router.post('/:id/delete', (req, res) => {
  const invoice = db.get('SELECT id, invoice_number, status FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Invoice not found.' });
  }
  if (!['draft', 'void'].includes(invoice.status)) {
    setFlash(req, 'error', `Cannot delete ${invoice.invoice_number} in status "${invoice.status}". Void it first.`);
    return res.redirect(`/invoices/${invoice.id}`);
  }
  db.run('DELETE FROM invoice_line_items WHERE invoice_id = ?', [invoice.id]);
  db.run('DELETE FROM invoices WHERE id = ?', [invoice.id]);
  setFlash(req, 'success', `${invoice.invoice_number} deleted.`);
  res.redirect('/invoices');
});

module.exports = router;
