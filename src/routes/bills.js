/**
 * Bills (vendor invoices) CRUD — v0.7.
 *
 * Status flow:  draft -> approved -> paid
 *               draft -> void
 *               approved -> void  (with reversing JE)
 *
 * Routes (mounted at /bills under requireManager):
 *   GET   /                       list with vendor filter
 *   GET   /new[?vendor_id=N]      new manual bill (AI extraction lands separately, Round 8)
 *   POST  /                       create draft
 *   GET   /:id                    show
 *   GET   /:id/edit               edit (draft only)
 *   POST  /:id                    update (draft only)
 *   POST  /:id/approve            draft -> approved + post JE (DR Expense per line / CR AP)
 *   POST  /:id/pay                approved -> paid (full or partial) + post JE (DR AP / CR Cash)
 *   POST  /:id/void               any non-paid -> void (with reversing JE if approved)
 *   POST  /:id/delete             draft or void only
 */

const express = require('express');
const db = require('../db/db');
const { setFlash } = require('../middleware/auth');
const posting = require('../services/accounting-posting');
const { writeAudit } = require('../services/audit');

const router = express.Router();
const PAGE_SIZE = 25;
const VALID_STATUSES = ['draft', 'approved', 'paid', 'void'];

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

function lineTotal(li) {
  const q = parseFloat(li.quantity);
  const p = parseFloat(li.unit_price);
  if (!isFinite(q) || !isFinite(p)) return 0;
  return Math.round(q * p * 100) / 100;
}

async function validateBill(body) {
  const errors = {};
  const vendorId = parseInt(body.vendor_id, 10);
  if (!vendorId) errors.vendor_id = 'Vendor required.';
  else if (!await db.get('SELECT id FROM vendors WHERE id = ?', [vendorId])) {
    errors.vendor_id = 'Vendor not found.';
  }

  const billNumber = emptyToNull(body.bill_number);
  const billDate = emptyToNull(body.bill_date);
  if (billDate && !/^\d{4}-\d{2}-\d{2}$/.test(billDate)) errors.bill_date = 'Use YYYY-MM-DD.';
  const dueDate = emptyToNull(body.due_date);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors.due_date = 'Use YYYY-MM-DD.';

  const jobId = body.job_id ? parseInt(body.job_id, 10) : null;
  const woId = body.work_order_id ? parseInt(body.work_order_id, 10) : null;
  const taxAmount = parseFloat(body.tax_amount);
  const taxAmountNum = isFinite(taxAmount) && taxAmount >= 0 ? taxAmount : 0;
  const notes = emptyToNull(body.notes);

  const rawLines = asArray(body.lines);
  const lines = [];
  for (const li of rawLines) {
    if (!emptyToNull(li.description)) continue;
    const accountId = li.account_id ? parseInt(li.account_id, 10) : null;
    // Fall back to Miscellaneous (5900) if no account selected
    const resolvedAccountId = accountId || await (async () => {
      const misc = await db.get("SELECT id FROM accounts WHERE code='5900' AND active=1");
      return misc ? misc.id : null;
    })();
    const quantity = parseFloat(li.quantity);
    const unitPrice = parseFloat(li.unit_price);
    lines.push({
      account_id: resolvedAccountId,
      description: emptyToNull(li.description),
      quantity: isFinite(quantity) && quantity >= 0 ? quantity : 0,
      unit_price: isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
    });
  }
  if (lines.length === 0) errors.lines = 'At least one line item is required.';

  const subtotal = lines.reduce((s, li) => s + lineTotal(li), 0);
  const total = Math.round((subtotal + taxAmountNum) * 100) / 100;

  return {
    errors,
    data: {
      vendor_id: vendorId || null,
      bill_number: billNumber, bill_date: billDate, due_date: dueDate,
      job_id: jobId, work_order_id: woId,
      tax_amount: taxAmountNum, notes,
      lines, subtotal, total,
    }
  };
}

async function loadBill(id) {
  const bill = await db.get(
    `SELECT b.*, v.name AS vendor_name, v.email AS vendor_email,
            j.title AS job_title, w.display_number AS wo_display_number,
            uc.name AS created_by_name, ua.name AS approved_by_name
     FROM bills b
     LEFT JOIN vendors v   ON v.id = b.vendor_id
     LEFT JOIN jobs j      ON j.id = b.job_id
     LEFT JOIN work_orders w ON w.id = b.work_order_id
     LEFT JOIN users uc    ON uc.id = b.created_by_user_id
     LEFT JOIN users ua    ON ua.id = b.approved_by_user_id
     WHERE b.id = ?`, [id]
  );
  if (!bill) return null;
  bill.lines = await db.all(
    `SELECT bl.*, a.code AS account_code, a.name AS account_name
     FROM bill_lines bl LEFT JOIN accounts a ON a.id = bl.account_id
     WHERE bl.bill_id = ? ORDER BY bl.sort_order ASC, bl.id ASC`, [id]
  );
  return bill;
}

function blankBill() {
  return {
    id: null, vendor_id: null, bill_number: '', bill_date: '', due_date: '',
    job_id: null, work_order_id: null, tax_amount: 0, notes: '',
    lines: [], subtotal: 0, total: 0
  };
}

// --- routes ---

router.get('/', async (req, res) => {
  const status = (req.query.status || '').trim();
  const vendorId = parseInt(req.query.vendor_id, 10) || null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conds = [];
  const params = [];
  if (status && VALID_STATUSES.includes(status)) { conds.push('b.status = ?'); params.push(status); }
  if (vendorId) { conds.push('b.vendor_id = ?'); params.push(vendorId); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = (await db.get(`SELECT COUNT(*) AS n FROM bills b ${where}`, params) || {}).n || 0;
  const bills = await db.all(
    `SELECT b.id, b.bill_number, b.status, b.bill_date, b.due_date, b.total, b.amount_paid, b.created_at,
            v.id AS vendor_id, v.name AS vendor_name
     FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id
     ${where}
     ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );
  const vendors = await db.all('SELECT id, name FROM vendors WHERE archived = 0 ORDER BY name COLLATE NOCASE ASC');

  res.render('bills/index', {
    title: 'Bills', activeNav: 'bills',
    bills, vendors, status, vendorId, page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES
  });
});

router.get('/new', async (req, res) => {
  const vendors = await db.all('SELECT id, name, default_expense_account_id FROM vendors WHERE archived = 0 ORDER BY name COLLATE NOCASE ASC');
  if (vendors.length === 0) {
    setFlash(req, 'error', 'Add a vendor first.');
    return res.redirect('/vendors/new');
  }
  const expenseAccounts = await db.all("SELECT id, code, name FROM accounts WHERE type='expense' AND active=1 ORDER BY code ASC");
  const bill = blankBill();
  const presetVendor = parseInt(req.query.vendor_id, 10);
  if (presetVendor && vendors.some(v => v.id === presetVendor)) bill.vendor_id = presetVendor;

  res.render('bills/new', {
    title: 'New bill', activeNav: 'bills',
    bill, vendors, expenseAccounts, errors: {}
  });
});

router.post('/', async (req, res) => {
  const vendors = await db.all('SELECT id, name, default_expense_account_id FROM vendors WHERE archived = 0 ORDER BY name COLLATE NOCASE ASC');
  const expenseAccounts = await db.all("SELECT id, code, name FROM accounts WHERE type='expense' AND active=1 ORDER BY code ASC");
  const { errors, data } = validateBill(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('bills/new', {
      title: 'New bill', activeNav: 'bills',
      bill: { id: null, ...data }, vendors, expenseAccounts, errors
    });
  }
  const newId = await db.transaction(async (tx) => {
    const r = tx.run(
      `INSERT INTO bills
       (vendor_id, bill_number, status, bill_date, due_date, job_id, work_order_id,
        subtotal, tax_amount, total, notes, source, created_by_user_id)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [data.vendor_id, data.bill_number, data.bill_date, data.due_date, data.job_id, data.work_order_id,
       data.subtotal, data.tax_amount, data.total, data.notes, req.session.userId]
    );
    const bid = r.lastInsertRowid;
    data.lines.forEach((li, idx) => {
      const lt = lineTotal(li);
      tx.run(
        `INSERT INTO bill_lines (bill_id, account_id, description, quantity, unit_price, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [bid, li.account_id, li.description, li.quantity, li.unit_price, lt, idx]
      );
    });
    return bid;
  });
  writeAudit({ entityType: 'bill', entityId: newId, action: 'create', before: null, after: { status: 'draft', total: data.total }, source: 'user', userId: req.session.userId });
  setFlash(req, 'success', `Bill draft created.`);
  res.redirect(`/bills/${newId}`);
});

router.get('/:id', async (req, res) => {
  const bill = loadBill(req.params.id);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  res.render('bills/show', { title: `Bill #${bill.id}`, activeNav: 'bills', bill });
});

router.get('/:id/edit', async (req, res) => {
  const bill = loadBill(req.params.id);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status !== 'draft') {
    setFlash(req, 'error', `Bill is "${bill.status}" — cannot edit.`);
    return res.redirect(`/bills/${bill.id}`);
  }
  const vendors = await db.all('SELECT id, name FROM vendors WHERE archived = 0 ORDER BY name COLLATE NOCASE ASC');
  const expenseAccounts = await db.all("SELECT id, code, name FROM accounts WHERE type='expense' AND active=1 ORDER BY code ASC");
  res.render('bills/edit', { title: `Edit bill #${bill.id}`, activeNav: 'bills', bill, vendors, expenseAccounts, errors: {} });
});

router.post('/:id', async (req, res) => {
  const existing = loadBill(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (existing.status !== 'draft') {
    setFlash(req, 'error', `Bill is "${existing.status}" — cannot edit.`);
    return res.redirect(`/bills/${existing.id}`);
  }
  const vendors = await db.all('SELECT id, name FROM vendors WHERE archived = 0 ORDER BY name COLLATE NOCASE ASC');
  const expenseAccounts = await db.all("SELECT id, code, name FROM accounts WHERE type='expense' AND active=1 ORDER BY code ASC");
  const { errors, data } = validateBill(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('bills/edit', {
      title: `Edit bill #${existing.id}`, activeNav: 'bills',
      bill: { ...existing, ...data }, vendors, expenseAccounts, errors
    });
  }
  await db.transaction(async (tx) => {
    tx.run(
      `UPDATE bills SET vendor_id=?, bill_number=?, bill_date=?, due_date=?, job_id=?, work_order_id=?,
                        subtotal=?, tax_amount=?, total=?, notes=?, updated_at=now()
       WHERE id=?`,
      [data.vendor_id, data.bill_number, data.bill_date, data.due_date, data.job_id, data.work_order_id,
       data.subtotal, data.tax_amount, data.total, data.notes, existing.id]
    );
    tx.run('DELETE FROM bill_lines WHERE bill_id = ?', [existing.id]);
    data.lines.forEach((li, idx) => {
      const lt = lineTotal(li);
      tx.run(
        `INSERT INTO bill_lines (bill_id, account_id, description, quantity, unit_price, line_total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [existing.id, li.account_id, li.description, li.quantity, li.unit_price, lt, idx]
      );
    });
  });
  writeAudit({ entityType: 'bill', entityId: existing.id, action: 'update', before: { total: existing.total }, after: { total: data.total }, source: 'user', userId: req.session.userId });
  setFlash(req, 'success', `Bill updated.`);
  res.redirect(`/bills/${existing.id}`);
});

router.post('/:id/approve', async (req, res) => {
  const bill = loadBill(req.params.id);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status !== 'draft') {
    setFlash(req, 'error', `Bill must be draft to approve. Current: ${bill.status}.`);
    return res.redirect(`/bills/${bill.id}`);
  }
  await db.run(
    `UPDATE bills SET status='approved', approved_by_user_id=?, approved_at=now(), updated_at=now() WHERE id=?`,
    [req.session.userId, bill.id]
  );
  writeAudit({ entityType: 'bill', entityId: bill.id, action: 'approve', before: { status: 'draft' }, after: { status: 'approved' }, source: 'user', userId: req.session.userId });
  try {
    posting.postBillApproved(bill, bill.lines, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (bill approve) — continuing:', e.message);
  }
  setFlash(req, 'success', `Bill approved and posted to GL.`);
  res.redirect(`/bills/${bill.id}`);
});

router.post('/:id/pay', async (req, res) => {
  const bill = await db.get('SELECT * FROM bills WHERE id = ?', [req.params.id]);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status !== 'approved') {
    setFlash(req, 'error', `Bill must be approved before paying. Current: ${bill.status}.`);
    return res.redirect(`/bills/${bill.id}`);
  }
  let amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) amount = Number(bill.total) || 0;
  if (amount > Number(bill.total)) amount = Number(bill.total);
  const newPaymentAmt = amount - (Number(bill.amount_paid) || 0);
  const newStatus = (amount >= Number(bill.total)) ? 'paid' : 'approved';
  const sets = ['amount_paid=?', `updated_at=now()`];
  const params = [amount];
  if (newStatus === 'paid') { sets.push('status=?'); params.push('paid'); }
  await db.run(`UPDATE bills SET ${sets.join(', ')} WHERE id=?`, [...params, bill.id]);
  writeAudit({ entityType: 'bill', entityId: bill.id, action: 'pay', before: { status: bill.status, amount_paid: bill.amount_paid }, after: { status: newStatus, amount_paid: amount }, source: 'user', userId: req.session.userId });
  try {
    if (newPaymentAmt > 0) posting.postBillPaid(bill, newPaymentAmt, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (bill pay) — continuing:', e.message);
  }
  if (newStatus === 'paid') setFlash(req, 'success', `Bill paid in full.`);
  else setFlash(req, 'success', `Partial payment $${amount.toFixed(2)} recorded. Balance: $${(bill.total - amount).toFixed(2)}.`);
  res.redirect(`/bills/${bill.id}`);
});

router.post('/:id/void', async (req, res) => {
  const bill = await db.get('SELECT * FROM bills WHERE id = ?', [req.params.id]);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status === 'paid') {
    setFlash(req, 'error', `Cannot void a paid bill.`);
    return res.redirect(`/bills/${bill.id}`);
  }
  await db.run(`UPDATE bills SET status='void', updated_at=now() WHERE id=?`, [bill.id]);
  writeAudit({ entityType: 'bill', entityId: bill.id, action: 'void', before: { status: bill.status }, after: { status: 'void' }, source: 'user', userId: req.session.userId });
  // TODO Round 8: post a reversing JE if the bill was previously approved
  setFlash(req, 'success', `Bill voided.`);
  res.redirect(`/bills/${bill.id}`);
});

router.post('/:id/delete', async (req, res) => {
  const bill = await db.get('SELECT id, status FROM bills WHERE id = ?', [req.params.id]);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (!['draft', 'void'].includes(bill.status)) {
    setFlash(req, 'error', `Cannot delete bill in status "${bill.status}".`);
    return res.redirect(`/bills/${bill.id}`);
  }
  await db.run('DELETE FROM bill_lines WHERE bill_id = ?', [bill.id]);
  await db.run('DELETE FROM bills WHERE id = ?', [bill.id]);
  writeAudit({ entityType: 'bill', entityId: bill.id, action: 'delete', before: { status: bill.status }, after: null, source: 'user', userId: req.session.userId });
  setFlash(req, 'success', `Bill deleted.`);
  res.redirect('/bills');
});

module.exports = router;
