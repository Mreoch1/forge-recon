/**
 * Work Orders CRUD + status transitions.
 *
 * WOs are created via "Convert estimate to WO" action on an accepted
 * estimate (POST /estimates/:id/convert-to-wo). There is intentionally
 * no "create WO from scratch" route in v0 — WOs always trace back to an
 * estimate. (Standalone WO creation is in TODO_FOR_MICHAEL for v1.)
 *
 * Routes (mounted at /work-orders, all gated by requireAuth):
 *   GET   /                 list with filters
 *   GET   /:id              show
 *   GET   /:id/edit         edit (allowed for scheduled or in_progress)
 *   POST  /:id              update
 *   POST  /:id/start        scheduled -> in_progress
 *   POST  /:id/complete     in_progress -> complete (stamps completed_date)
 *   POST  /:id/cancel       any non-complete -> cancelled
 *   GET   /:id/pdf          PDF (inline preview by default, ?download=1 forces save)
 *   POST  /:id/delete       delete (FK guard against invoices)
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['scheduled', 'in_progress', 'complete', 'cancelled'];
const VALID_TRADES = [
  'general','electrical','plumbing','hvac','framing',
  'drywall','paint','flooring','cabinetry','roofing','other'
];
const VALID_UNITS = ['ea', 'hr', 'sqft', 'lf', 'ton', 'lot'];

// --- helpers ---

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function asArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input !== 'object') return [];
  return Object.keys(input)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map(k => input[k]);
}

function validateLineItem(li) {
  const errors = {};
  const description = emptyToNull(li.description);
  if (!description) errors.description = 'Required.';
  const trade = emptyToNull(li.trade) || 'general';
  if (!VALID_TRADES.includes(trade)) errors.trade = 'Invalid trade.';
  const unit = emptyToNull(li.unit) || 'ea';
  if (!VALID_UNITS.includes(unit)) errors.unit = 'Invalid unit.';
  const quantity = parseFloat(li.quantity);
  if (!isFinite(quantity) || quantity < 0) errors.quantity = 'Must be ≥ 0.';
  const unitPrice = parseFloat(li.unit_price);
  if (!isFinite(unitPrice) || unitPrice < 0) errors.unit_price = 'Must be ≥ 0.';
  const completed = li.completed === '1' || li.completed === 'on' || li.completed === true ? 1 : 0;

  return { errors, data: { description, trade, unit, quantity, unit_price: unitPrice, completed } };
}

function validateWorkOrder(body) {
  const errors = {};

  const scheduledDate = emptyToNull(body.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    errors.scheduled_date = 'Use YYYY-MM-DD.';
  }
  const assignedTo = emptyToNull(body.assigned_to);
  const notes = emptyToNull(body.notes);

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    const isBlank =
      !emptyToNull(li.description) &&
      (!li.quantity || parseFloat(li.quantity) === 0) &&
      (!li.unit_price || parseFloat(li.unit_price) === 0);
    if (isBlank) return;
    const v = validateLineItem(li);
    items.push(v.data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';

  return {
    errors,
    data: { scheduled_date: scheduledDate, assigned_to: assignedTo, notes, lines: items }
  };
}

function loadWorkOrder(id) {
  const wo = db.get(
    `SELECT w.*,
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
            e.estimate_number AS estimate_number
     FROM work_orders w
     JOIN jobs j      ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN estimates e ON e.id = w.estimate_id
     WHERE w.id = ?`,
    [id]
  );
  if (!wo) return null;
  wo.lines = db.all(
    `SELECT * FROM work_order_line_items WHERE work_order_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  return wo;
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
    conds.push('(w.wo_number LIKE ? OR j.title LIKE ? OR c.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    conds.push('w.status = ?');
    params.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (db.get(
    `SELECT COUNT(*) AS n
     FROM work_orders w
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id ${where}`, params
  ) || {}).n || 0;

  const workOrders = db.all(
    `SELECT w.id, w.wo_number, w.status, w.scheduled_date, w.completed_date, w.assigned_to, w.created_at,
            j.id AS job_id, j.title AS job_title,
            c.id AS customer_id, c.name AS customer_name
     FROM work_orders w
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     ${where}
     ORDER BY w.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('work-orders/index', {
    title: 'Work Orders',
    activeNav: 'work-orders',
    workOrders, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/:id', (req, res) => {
  const wo = loadWorkOrder(req.params.id);
  if (!wo) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  }
  // Pull related invoice if any
  const invoice = db.get('SELECT id, invoice_number, status FROM invoices WHERE work_order_id = ?', [wo.id]);
  res.render('work-orders/show', {
    title: wo.wo_number,
    activeNav: 'work-orders',
    wo, invoice
  });
});

router.get('/:id/edit', (req, res) => {
  const wo = loadWorkOrder(req.params.id);
  if (!wo) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  }
  if (wo.status === 'complete' || wo.status === 'cancelled') {
    setFlash(req, 'error', `${wo.wo_number} is "${wo.status}" and cannot be edited.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  res.render('work-orders/edit', {
    title: `Edit ${wo.wo_number}`,
    activeNav: 'work-orders',
    wo, errors: {},
    trades: VALID_TRADES, units: VALID_UNITS
  });
});

router.post('/:id', (req, res) => {
  const existing = loadWorkOrder(req.params.id);
  if (!existing) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  }
  if (existing.status === 'complete' || existing.status === 'cancelled') {
    setFlash(req, 'error', `${existing.wo_number} is "${existing.status}" and cannot be edited.`);
    return res.redirect(`/work-orders/${existing.id}`);
  }

  const { errors, data } = validateWorkOrder(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('work-orders/edit', {
      title: `Edit ${existing.wo_number}`,
      activeNav: 'work-orders',
      wo: { ...existing, ...data },
      errors, trades: VALID_TRADES, units: VALID_UNITS
    });
  }

  db.transaction(() => {
    db.run(
      `UPDATE work_orders
       SET scheduled_date=?, assigned_to=?, notes=?, updated_at=datetime('now')
       WHERE id=?`,
      [data.scheduled_date, data.assigned_to, data.notes, existing.id]
    );
    db.run('DELETE FROM work_order_line_items WHERE work_order_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO work_order_line_items
         (work_order_id, trade, description, quantity, unit, unit_price, line_total, completed, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [existing.id, li.trade, li.description, li.quantity, li.unit, li.unit_price, lt, li.completed, idx]
      );
    });
  });

  setFlash(req, 'success', `${existing.wo_number} updated.`);
  res.redirect(`/work-orders/${existing.id}`);
});

// --- status transitions ---

function statusTransition(req, res, fromStatus, toStatus, timestampField) {
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  }
  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(wo.status)) {
    setFlash(req, 'error', `Cannot move ${wo.wo_number} from "${wo.status}" to "${toStatus}".`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const params = [toStatus];
  if (timestampField) sets.push(`${timestampField} = datetime('now')`);
  db.run(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = ?`, [...params, wo.id]);
  setFlash(req, 'success', `${wo.wo_number} marked ${toStatus.replace('_',' ')}.`);
  res.redirect(`/work-orders/${wo.id}`);
}

router.post('/:id/start',    (req, res) => statusTransition(req, res, 'scheduled', 'in_progress', null));
router.post('/:id/complete', (req, res) => statusTransition(req, res, 'in_progress', 'complete', 'completed_date'));
router.post('/:id/cancel',   (req, res) => statusTransition(req, res, ['scheduled','in_progress'], 'cancelled', null));

// --- PDF ---

router.get('/:id/pdf', (req, res) => {
  const wo = loadWorkOrder(req.params.id);
  if (!wo) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  }
  const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  const filename = `${wo.wo_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    pdf.generateWorkOrderPDF(wo, company, res);
  } catch (err) {
    console.error('WO PDF generation failed:', err);
    if (!res.headersSent) {
      res.status(500).render('error', { title: 'PDF error', code: 500, message: 'PDF generation failed.' });
    } else {
      res.end();
    }
  }
});

// --- delete ---

router.post('/:id/delete', (req, res) => {
  const wo = db.get('SELECT id, wo_number FROM work_orders WHERE id = ?', [req.params.id]);
  if (!wo) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  }
  const invCount = (db.get('SELECT COUNT(*) AS n FROM invoices WHERE work_order_id = ?', [wo.id]) || {}).n || 0;
  if (invCount > 0) {
    setFlash(req, 'error', `Cannot delete ${wo.wo_number} — ${invCount} invoice(s) reference it.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  db.run('DELETE FROM work_order_line_items WHERE work_order_id = ?', [wo.id]);
  db.run('DELETE FROM work_orders WHERE id = ?', [wo.id]);
  setFlash(req, 'success', `${wo.wo_number} deleted.`);
  res.redirect('/work-orders');
});

module.exports = router;
