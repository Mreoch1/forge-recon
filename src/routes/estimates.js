/**
 * Estimates CRUD + status transitions.
 *
 * Routes (all gated by requireAuth in server.js, mounted at /estimates):
 *   GET   /                 list with filters
 *   GET   /new?job_id=N     new form (job_id required)
 *   POST  /                 create
 *   GET   /:id              show (with line items + status actions)
 *   GET   /:id/edit         edit form
 *   POST  /:id              update
 *   POST  /:id/send         status -> sent, sent_at = now (only from draft)
 *   POST  /:id/accept       status -> accepted, accepted_at = now (only from sent)
 *   POST  /:id/reject       status -> rejected (only from sent)
 *   POST  /:id/delete       delete (FK guard against work_orders)
 *
 * PDF route lives separately in Phase 3B.
 *
 * Line items arrive as req.body.lines = { '0': {...}, '1': {...}, ... }
 * (Express parses array-style indices into an object). We Object.values()
 * to get them in submission order.
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const numbering = require('../services/numbering');
const calc = require('../services/calculations');
const pdf = require('../services/pdf');

const router = express.Router();

const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'];
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

function asLineItemsArray(input) {
  // Express body-parser turns lines[0][...] into either an array or an
  // object with numeric keys depending on indices. Normalize to array.
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

  return {
    errors,
    data: { description, trade, unit, quantity, unit_price: unitPrice }
  };
}

function validateEstimate(body) {
  const errors = {};

  const jobId = parseInt(body.job_id, 10);
  if (!jobId) errors.job_id = 'Job is required.';
  else {
    const job = db.get('SELECT id FROM jobs WHERE id = ?', [jobId]);
    if (!job) errors.job_id = 'Job not found.';
  }

  const status = emptyToNull(body.status) || 'draft';
  if (!VALID_STATUSES.includes(status)) errors.status = 'Invalid status.';

  const validUntil = emptyToNull(body.valid_until);
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    errors.valid_until = 'Use YYYY-MM-DD format.';
  }

  const taxRate = parseFloat(body.tax_rate);
  const taxRateNum = isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;

  const notes = emptyToNull(body.notes);

  const rawItems = asLineItemsArray(body.lines);
  const items = [];
  const itemErrors = [];
  rawItems.forEach((li, idx) => {
    // Skip fully-blank rows (user may have added & emptied a row)
    const isBlank =
      !emptyToNull(li.description) &&
      (!li.quantity || parseFloat(li.quantity) === 0) &&
      (!li.unit_price || parseFloat(li.unit_price) === 0);
    if (isBlank) return;
    const v = validateLineItem(li);
    if (Object.keys(v.errors).length) {
      itemErrors[idx] = v.errors;
    }
    items.push(v.data);
  });
  if (items.length === 0) errors.lines = 'At least one line item is required.';
  if (itemErrors.length) errors.itemErrors = itemErrors;

  return {
    errors,
    data: {
      job_id: jobId, status, valid_until: validUntil, notes,
      tax_rate: taxRateNum,
      lines: items,
    }
  };
}

function loadDefaults(jobId) {
  const settings = db.get('SELECT default_tax_rate FROM company_settings WHERE id = 1') || { default_tax_rate: 0 };
  return {
    id: null, job_id: jobId || null, estimate_number: null,
    status: 'draft',
    subtotal: 0, tax_rate: settings.default_tax_rate || 0,
    tax_amount: 0, total: 0,
    valid_until: '', notes: '',
    lines: []
  };
}

function loadEstimate(id) {
  // Pulls customer + job fields needed by the PDF generator alongside the
  // standard estimate row. Aliased prefixes keep the namespace clean.
  const est = db.get(
    `SELECT e.*,
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
            c.zip     AS customer_zip
     FROM estimates e
     JOIN jobs j ON j.id = e.job_id
     JOIN customers c ON c.id = j.customer_id
     WHERE e.id = ?`,
    [id]
  );
  if (!est) return null;
  est.lines = db.all(
    `SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  return est;
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
    conds.push('(e.estimate_number LIKE ? OR j.title LIKE ? OR c.name LIKE ?)');
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
     JOIN jobs j ON j.id = e.job_id
     JOIN customers c ON c.id = j.customer_id ${where}`, params
  ) || {}).n || 0;

  const estimates = db.all(
    `SELECT e.id, e.estimate_number, e.status, e.total, e.valid_until, e.created_at,
            j.id AS job_id, j.title AS job_title,
            c.id AS customer_id, c.name AS customer_name
     FROM estimates e
     JOIN jobs j ON j.id = e.job_id
     JOIN customers c ON c.id = j.customer_id
     ${where}
     ORDER BY e.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  res.render('estimates/index', {
    title: 'Estimates',
    activeNav: 'estimates',
    estimates, q, status, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/new', (req, res) => {
  const jobId = parseInt(req.query.job_id, 10);
  if (!jobId) {
    setFlash(req, 'error', 'Pick a job first to create an estimate from.');
    return res.redirect('/jobs');
  }
  const job = db.get(
    `SELECT j.*, c.id AS customer_id, c.name AS customer_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     WHERE j.id = ?`, [jobId]
  );
  if (!job) {
    setFlash(req, 'error', 'Job not found.');
    return res.redirect('/jobs');
  }

  const estimate = loadDefaults(jobId);
  res.render('estimates/new', {
    title: 'New estimate',
    activeNav: 'estimates',
    estimate, job, errors: {},
    trades: VALID_TRADES, units: VALID_UNITS, statuses: VALID_STATUSES
  });
});

router.post('/', (req, res) => {
  const { errors, data } = validateEstimate(req.body);
  const job = data.job_id ? db.get(
    `SELECT j.*, c.id AS customer_id, c.name AS customer_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`,
    [data.job_id]
  ) : null;

  if (Object.keys(errors).length) {
    return res.status(400).render('estimates/new', {
      title: 'New estimate',
      activeNav: 'estimates',
      estimate: { id: null, ...data },
      job: job || { id: data.job_id },
      errors,
      trades: VALID_TRADES, units: VALID_UNITS, statuses: VALID_STATUSES
    });
  }

  const t = calc.totals(data.lines, data.tax_rate);
  const estimateNumber = numbering.nextEstimateNumber();

  const newId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO estimates (job_id, estimate_number, status, subtotal, tax_rate, tax_amount, total, valid_until, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.job_id, estimateNumber, data.status, t.subtotal, data.tax_rate, t.taxAmount, t.total, data.valid_until, data.notes]
    );
    const eid = r.lastInsertRowid;
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO estimate_line_items (estimate_id, trade, description, quantity, unit, unit_price, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [eid, li.trade, li.description, li.quantity, li.unit, li.unit_price, lt, idx]
      );
    });
    return eid;
  });

  setFlash(req, 'success', `Estimate ${estimateNumber} created.`);
  res.redirect(`/estimates/${newId}`);
});

router.get('/:id', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  res.render('estimates/show', {
    title: estimate.estimate_number,
    activeNav: 'estimates',
    estimate
  });
});

router.get('/:id/edit', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  if (estimate.status !== 'draft') {
    setFlash(req, 'error', `Estimate ${estimate.estimate_number} is "${estimate.status}" and cannot be edited. Use status actions instead.`);
    return res.redirect(`/estimates/${estimate.id}`);
  }
  const job = db.get(
    `SELECT j.*, c.id AS customer_id, c.name AS customer_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     WHERE j.id = ?`, [estimate.job_id]
  );
  res.render('estimates/edit', {
    title: `Edit ${estimate.estimate_number}`,
    activeNav: 'estimates',
    estimate, job, errors: {},
    trades: VALID_TRADES, units: VALID_UNITS, statuses: VALID_STATUSES
  });
});

router.post('/:id', (req, res) => {
  const existing = db.get('SELECT id, estimate_number, status, job_id FROM estimates WHERE id = ?', [req.params.id]);
  if (!existing) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  if (existing.status !== 'draft') {
    setFlash(req, 'error', `Estimate ${existing.estimate_number} is "${existing.status}" and cannot be edited.`);
    return res.redirect(`/estimates/${existing.id}`);
  }

  // Force the job_id from the existing record (don't allow re-parenting via form)
  const body = { ...req.body, job_id: existing.job_id };
  const { errors, data } = validateEstimate(body);

  const job = db.get(
    `SELECT j.*, c.id AS customer_id, c.name AS customer_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     WHERE j.id = ?`, [existing.job_id]
  );

  if (Object.keys(errors).length) {
    return res.status(400).render('estimates/edit', {
      title: `Edit ${existing.estimate_number}`,
      activeNav: 'estimates',
      estimate: { id: existing.id, estimate_number: existing.estimate_number, ...data },
      job, errors,
      trades: VALID_TRADES, units: VALID_UNITS, statuses: VALID_STATUSES
    });
  }

  const t = calc.totals(data.lines, data.tax_rate);

  db.transaction(() => {
    db.run(
      `UPDATE estimates
       SET subtotal=?, tax_rate=?, tax_amount=?, total=?, valid_until=?, notes=?, updated_at=datetime('now')
       WHERE id=?`,
      [t.subtotal, data.tax_rate, t.taxAmount, t.total, data.valid_until, data.notes, existing.id]
    );
    db.run('DELETE FROM estimate_line_items WHERE estimate_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = calc.lineTotal(li);
      db.run(
        `INSERT INTO estimate_line_items (estimate_id, trade, description, quantity, unit, unit_price, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [existing.id, li.trade, li.description, li.quantity, li.unit, li.unit_price, lt, idx]
      );
    });
  });

  setFlash(req, 'success', `Estimate ${existing.estimate_number} updated.`);
  res.redirect(`/estimates/${existing.id}`);
});

// --- status transitions ---

function statusTransition(req, res, fromStatus, toStatus, timestampField) {
  const est = db.get('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
  if (!est) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(est.status)) {
    setFlash(req, 'error', `Cannot move ${est.estimate_number} from "${est.status}" to "${toStatus}".`);
    return res.redirect(`/estimates/${est.id}`);
  }
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const params = [toStatus];
  if (timestampField) {
    sets.push(`${timestampField} = datetime('now')`);
  }
  db.run(`UPDATE estimates SET ${sets.join(', ')} WHERE id = ?`, [...params, est.id]);
  setFlash(req, 'success', `Estimate ${est.estimate_number} marked ${toStatus}.`);
  res.redirect(`/estimates/${est.id}`);
}

// PDF (read-only — anyone authed can fetch). Streams pdfkit output to res.
router.get('/:id/pdf', (req, res) => {
  const estimate = loadEstimate(req.params.id);
  if (!estimate) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  const company = db.get('SELECT * FROM company_settings WHERE id = 1') || {};

  // Inline preview vs forced download: ?download=1 forces save dialog.
  const filename = `${estimate.estimate_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    pdf.generateEstimatePDF(estimate, company, res);
  } catch (err) {
    // Headers may already be sent by the time pdfkit errors. Best we can
    // do is log + drop the connection.
    console.error('PDF generation failed:', err);
    if (!res.headersSent) {
      res.status(500).render('error', { title: 'PDF error', code: 500, message: 'PDF generation failed.' });
    } else {
      res.end();
    }
  }
});

router.post('/:id/send',   (req, res) => statusTransition(req, res, 'draft', 'sent', 'sent_at'));
router.post('/:id/accept', (req, res) => statusTransition(req, res, 'sent', 'accepted', 'accepted_at'));
router.post('/:id/reject', (req, res) => statusTransition(req, res, 'sent', 'rejected', null));

// Convert an accepted estimate into a Work Order. Copies line items
// across (but each WO line gets its own row — modifying the WO does not
// affect the estimate). Allowed only from status='accepted'. Multiple
// conversions are permitted (an estimate can spawn N WOs if a job is
// being phased — the estimate is the proposal, the WOs are dispatch).
router.post('/:id/convert-to-wo', (req, res) => {
  const est = db.get('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
  if (!est) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  if (est.status !== 'accepted') {
    setFlash(req, 'error', `Estimate ${est.estimate_number} must be accepted before converting to a work order. Current status: ${est.status}.`);
    return res.redirect(`/estimates/${est.id}`);
  }

  const lines = db.all(
    `SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC, id ASC`,
    [est.id]
  );

  const woNumber = numbering.nextWONumber();
  const newWoId = db.transaction(() => {
    const r = db.run(
      `INSERT INTO work_orders (job_id, estimate_id, wo_number, status, notes)
       VALUES (?, ?, ?, 'scheduled', ?)`,
      [est.job_id, est.id, woNumber, est.notes]
    );
    const woId = r.lastInsertRowid;
    lines.forEach((li, idx) => {
      db.run(
        `INSERT INTO work_order_line_items
         (work_order_id, trade, description, quantity, unit, unit_price, line_total, completed, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [woId, li.trade, li.description, li.quantity, li.unit, li.unit_price, li.line_total, idx]
      );
    });
    return woId;
  });

  setFlash(req, 'success', `${est.estimate_number} converted to ${woNumber}.`);
  res.redirect(`/work-orders/${newWoId}`);
});

router.post('/:id/delete', (req, res) => {
  const est = db.get('SELECT id, estimate_number FROM estimates WHERE id = ?', [req.params.id]);
  if (!est) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Estimate not found.' });
  }
  const woCount = (db.get('SELECT COUNT(*) AS n FROM work_orders WHERE estimate_id = ?', [est.id]) || {}).n || 0;
  if (woCount > 0) {
    setFlash(req, 'error', `Cannot delete ${est.estimate_number} — ${woCount} work order(s) reference it.`);
    return res.redirect(`/estimates/${est.id}`);
  }
  db.run('DELETE FROM estimate_line_items WHERE estimate_id = ?', [est.id]);
  db.run('DELETE FROM estimates WHERE id = ?', [est.id]);
  setFlash(req, 'success', `Estimate ${est.estimate_number} deleted.`);
  res.redirect('/estimates');
});

module.exports = router;
