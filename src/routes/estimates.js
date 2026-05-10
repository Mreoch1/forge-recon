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
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');
const email = require('../services/email');

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
  const selected = (li.selected === '1' || li.selected === 'on' || li.selected === true) ? 1 : 0;
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

function loadEstimate(id) {
  const est = db.get(
    `SELECT e.*,
            w.id AS wo_id, w.display_number AS wo_display_number,
            w.wo_number_main, w.wo_number_sub,
            j.id AS job_id, j.title AS job_title,
            j.address AS job_address, j.city AS job_city, j.state AS job_state, j.zip AS job_zip,
            c.id AS customer_id, c.name AS customer_name,
            c.email AS customer_email, c.billing_email AS customer_billing_email,
            c.phone AS customer_phone,
            c.address AS customer_address, c.city AS customer_city, c.state AS customer_state, c.zip AS customer_zip
     FROM estimates e
     JOIN work_orders w ON w.id = e.work_order_id
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     WHERE e.id = ?`,
    [id]
  );
  if (!est) return null;
  est.lines = db.all(
    `SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  est.display_number = `EST-${est.wo_display_number}`;
  return est;
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (q) {
    conds.push('(w.display_number LIKE ? OR j.title LIKE ? OR c.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    conds.push('e.status = ?');
    params.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (db.get(
    `SELECT COUNT(*) AS n FROM estimates e
     JOIN work_orders w ON w.id = e.work_order_id
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id ${where}`,
    params
  ) || {}).n || 0;

  const estimates = db.all(
    `SELECT e.id, e.status, e.total, e.valid_until, e.created_at,
            w.display_number AS wo_display_number, w.id AS wo_id,
            j.id AS job_id, j.title AS job_title,
            c.id AS customer_id, c.name AS customer_name
     FROM estimates e
     JOIN work_orders w ON w.id = e.work_order_id
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     ${where}
     ORDER BY e.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('estimates/index', {
    title: 'Estimates', activeNav: 'estimates',
    estimates, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/:id', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const invoice = db.get('SELECT id, status FROM invoices WHERE estimate_id = ?', [estimate.id]);
  res.render('estimates/show', {
    title: estimate.display_number, activeNav: 'estimates',
    estimate, invoice
  });
});

router.get('/:id/edit', (req, res) => {
  const estimate = loadEstimate(req.params.id);
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

router.post('/:id', (req, res) => {
  const existing = loadEstimate(req.params.id);
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
  db.transaction(() => {
    db.run(
      `UPDATE estimates SET subtotal=?, tax_rate=?, tax_amount=?, total=?, cost_total=?, valid_until=?, notes=?,
                            updated_at=datetime('now')
       WHERE id=?`,
      [t.subtotal, data.tax_rate, t.taxAmount, t.total, costTotal, data.valid_until, data.notes, existing.id]
    );
    db.run('DELETE FROM estimate_line_items WHERE estimate_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO estimate_line_items (estimate_id, description, quantity, unit, unit_price, cost, line_total, selected, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [existing.id, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, li.selected, idx]
      );
    });
  });
  setFlash(req, 'success', `${existing.display_number} updated.`);
  res.redirect(`/estimates/${existing.id}`);
});

function statusTransition(req, res, fromStatus, toStatus, timestampField) {
  const est = loadEstimate(req.params.id);
  if (!est) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(est.status)) {
    setFlash(req, 'error', `Cannot move ${est.display_number} from "${est.status}" to "${toStatus}".`);
    return res.redirect(`/estimates/${est.id}`);
  }
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const params = [toStatus];
  if (timestampField) sets.push(`${timestampField} = datetime('now')`);
  db.run(`UPDATE estimates SET ${sets.join(', ')} WHERE id = ?`, [...params, est.id]);
  setFlash(req, 'success', `${est.display_number} marked ${toStatus}.`);
  res.redirect(`/estimates/${est.id}`);
}

// Send: generate PDF, write .eml to mail-outbox/, transition draft -> sent
router.post('/:id/send', async (req, res, next) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (estimate.status !== 'draft') {
    setFlash(req, 'error', `${estimate.display_number} is "${estimate.status}" — already sent.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  try {
    const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
    const buf = await pdf.renderToBuffer(pdf.generateEstimatePDF, { ...estimate, estimate_number: estimate.display_number }, company);
    // Estimate goes to primary email (estimate; billing_email is for invoice)
    const recipient = estimate.customer_email || 'unknown@recon.local';
    const subject = `Estimate ${estimate.display_number} from ${company.company_name || 'Recon Construction'}`;
    const text = `Hello ${estimate.customer_name || ''},\n\nPlease find attached estimate ${estimate.display_number}.\nTotal: $${(Number(estimate.total)||0).toFixed(2)}\n\nThanks.\n${company.company_name || 'Recon Construction'}`;
    const sent = await email.sendEmail({
      to: recipient, subject, text,
      html: text.split('\n').map(l => `<p>${l}</p>`).join(''),
      attachments: [{ filename: `${estimate.display_number}.pdf`, content: buf, contentType: 'application/pdf' }]
    });
    db.run(`UPDATE estimates SET status='sent', sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, [estimate.id]);
    const note = sent.mode === 'file' ? ` Email saved to ${sent.filepath}.` : '';
    setFlash(req, 'success', `${estimate.display_number} sent.${note}`);
    res.redirect(`/estimates/${estimate.id}`);
  } catch (err) { next(err); }
});

router.post('/:id/accept', (req, res) => statusTransition(req, res, 'sent', 'accepted', 'accepted_at'));
router.post('/:id/reject', (req, res) => statusTransition(req, res, 'sent', 'rejected', null));

// Generate invoice from accepted estimate (only selected lines transfer)
router.post('/:id/generate-invoice', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  if (!['sent', 'accepted'].includes(estimate.status)) {
    setFlash(req, 'error', `Estimate must be sent or accepted before invoicing. Current: ${estimate.status}.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const existingInv = db.get('SELECT id FROM invoices WHERE estimate_id = ?', [estimate.id]);
  if (existingInv) {
    setFlash(req, 'info', `Invoice already exists for ${estimate.display_number}.`);
    return res.redirect(`/invoices/${existingInv.id}`);
  }

  const settings = db.get('SELECT default_payment_terms FROM company_settings WHERE id = 1') || {};
  const paymentTerms = settings.default_payment_terms || 'Net 30';
  // Compute due date based on payment terms
  const due = new Date();
  const termsMatch = String(paymentTerms).match(/Net (\d+)/i);
  if (termsMatch) due.setDate(due.getDate() + parseInt(termsMatch[1], 10));
  else if (/due on receipt/i.test(paymentTerms)) {} // due today
  else due.setDate(due.getDate() + 30); // default
  const dueDate = due.toISOString().slice(0, 10);

  const selectedLines = estimate.lines.filter(li => li.selected);
  if (selectedLines.length === 0) {
    setFlash(req, 'error', `No line items are marked as selected. Edit the estimate to select lines first.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const totals = calc.totals(selectedLines, estimate.tax_rate);
  const costTotal = selectedLines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);

  const newId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO invoices
       (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, payment_terms, due_date)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      [estimate.id, estimate.wo_id, totals.subtotal, estimate.tax_rate, totals.taxAmount, totals.total, costTotal, paymentTerms, dueDate]
    );
    const invId = r.lastInsertRowid;
    selectedLines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price, cost, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [invId, li.description, li.quantity, li.unit, li.unit_price, li.cost, lt, idx]
      );
    });
    return invId;
  });

  setFlash(req, 'success', `INV-${estimate.wo_display_number} generated (${selectedLines.length} line items transferred).`);
  res.redirect(`/invoices/${newId}`);
});

router.get('/:id/pdf', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  const filename = `${estimate.display_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    pdf.generateEstimatePDF({ ...estimate, estimate_number: estimate.display_number }, company, res);
  } catch (err) {
    console.error('Estimate PDF failed:', err);
    if (!res.headersSent) res.status(500).render('error', { title: 'PDF error', code: 500, message: err.message });
    else res.end();
  }
});

router.post('/:id/delete', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  const invCount = (db.get('SELECT COUNT(*) AS n FROM invoices WHERE estimate_id = ?', [estimate.id]) || {}).n || 0;
  if (invCount) {
    setFlash(req, 'error', `Cannot delete ${estimate.display_number} — an invoice references it.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  db.run('DELETE FROM estimate_line_items WHERE estimate_id = ?', [estimate.id]);
  db.run('DELETE FROM estimates WHERE id = ?', [estimate.id]);
  setFlash(req, 'success', `${estimate.display_number} deleted.`);
  res.redirect('/estimates');
});

module.exports = router;
