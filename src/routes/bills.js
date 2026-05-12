/**
 * Bills (vendor invoices) CRUD — Supabase SDK.
 *
 * Status flow:  draft -> approved -> paid
 *               draft -> void
 *               approved -> void  (with reversing JE)
 *
 * Routes (mounted at /bills under requireManager):
 *   GET   /                       list with vendor filter
 *   GET   /new[?vendor_id=N]      new manual bill
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
const supabase = require('../db/supabase');
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

async function lookupMiscAccountId() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id')
    .eq('code', '5900')
    .eq('active', 1)
    .maybeSingle();
  if (error) return null;
  return data ? data.id : null;
}

async function validateBill(body) {
  const errors = {};
  const vendorId = parseInt(body.vendor_id, 10);
  if (!vendorId) {
    errors.vendor_id = 'Vendor required.';
  } else {
    const { data: v } = await supabase.from('vendors').select('id').eq('id', vendorId).maybeSingle();
    if (!v) errors.vendor_id = 'Vendor not found.';
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

  // Resolve misc account id once if any line is missing an account_id
  let miscAccountId = null;
  const rawLines = asArray(body.lines);
  const lines = [];
  for (const li of rawLines) {
    if (!emptyToNull(li.description)) continue;
    let accountId = li.account_id ? parseInt(li.account_id, 10) : null;
    if (!accountId) {
      if (miscAccountId === null) miscAccountId = await lookupMiscAccountId();
      accountId = miscAccountId;
    }
    const quantity = parseFloat(li.quantity);
    const unitPrice = parseFloat(li.unit_price);
    lines.push({
      account_id: accountId,
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
  // Header + nested vendor / job / WO + audit-author names
  const { data: bill, error } = await supabase
    .from('bills')
    .select(`
      *,
      vendors!left(name, email),
      jobs!left(title),
      work_orders!left(display_number)
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!bill) return null;

  bill.vendor_name = bill.vendors?.name || null;
  bill.vendor_email = bill.vendors?.email || null;
  bill.job_title = bill.jobs?.title || null;
  bill.wo_display_number = bill.work_orders?.display_number || null;
  delete bill.vendors;
  delete bill.jobs;
  delete bill.work_orders;

  // Created/approved-by names (two FKs into users, can't multiplex via PostgREST cleanly)
  if (bill.created_by_user_id) {
    const { data: uc } = await supabase.from('users').select('name').eq('id', bill.created_by_user_id).maybeSingle();
    bill.created_by_name = uc?.name || null;
  } else {
    bill.created_by_name = null;
  }
  if (bill.approved_by_user_id) {
    const { data: ua } = await supabase.from('users').select('name').eq('id', bill.approved_by_user_id).maybeSingle();
    bill.approved_by_name = ua?.name || null;
  } else {
    bill.approved_by_name = null;
  }

  // Lines with account info
  const { data: lines, error: lineErr } = await supabase
    .from('bill_lines')
    .select('*, accounts!left(code, name)')
    .eq('bill_id', id)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (lineErr) throw lineErr;
  bill.lines = (lines || []).map(l => ({
    ...l,
    account_code: l.accounts?.code || null,
    account_name: l.accounts?.name || null,
  }));
  bill.lines.forEach(l => delete l.accounts);
  return bill;
}

function blankBill() {
  return {
    id: null, vendor_id: null, bill_number: '', bill_date: '', due_date: '',
    job_id: null, work_order_id: null, tax_amount: 0, notes: '',
    lines: [], subtotal: 0, total: 0
  };
}

async function loadVendorsAndAccounts() {
  const [{ data: vendors }, { data: expenseAccounts }] = await Promise.all([
    supabase
      .from('vendors')
      .select('id, name, default_expense_account_id')
      .eq('archived', 0)
      .order('name'),
    supabase
      .from('accounts')
      .select('id, code, name')
      .eq('type', 'expense')
      .eq('active', 1)
      .order('code'),
  ]);
  return { vendors: vendors || [], expenseAccounts: expenseAccounts || [] };
}

// --- routes ---

router.get('/', async (req, res) => {
  const status = (req.query.status || '').trim();
  const vendorId = parseInt(req.query.vendor_id, 10) || null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('bills')
    .select(`
      id, bill_number, status, bill_date, due_date, total, amount_paid, created_at,
      vendor_id, vendors!left(id, name)
    `, { count: 'exact', head: false });

  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }
  if (vendorId) {
    query = query.eq('vendor_id', vendorId);
  }

  const { data: rows, count: total, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;

  const bills = (rows || []).map(b => ({
    ...b,
    vendor_id: b.vendors?.id ?? b.vendor_id,
    vendor_name: b.vendors?.name || null,
  }));

  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('archived', 0)
    .order('name');

  res.render('bills/index', {
    title: 'Bills', activeNav: 'bills',
    bills, vendors: vendors || [], status, vendorId, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES
  });
});

router.get('/new', async (req, res) => {
  const { vendors, expenseAccounts } = await loadVendorsAndAccounts();
  if (vendors.length === 0) {
    setFlash(req, 'error', 'Add a vendor first.');
    return res.redirect('/vendors/new');
  }
  const bill = blankBill();
  const presetVendor = parseInt(req.query.vendor_id, 10);
  if (presetVendor && vendors.some(v => v.id === presetVendor)) bill.vendor_id = presetVendor;

  res.render('bills/new', {
    title: 'New bill', activeNav: 'bills',
    bill, vendors, expenseAccounts, errors: {}
  });
});

router.post('/', async (req, res) => {
  const { vendors, expenseAccounts } = await loadVendorsAndAccounts();
  const { errors, data } = await validateBill(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('bills/new', {
      title: 'New bill', activeNav: 'bills',
      bill: { id: null, ...data }, vendors, expenseAccounts, errors
    });
  }

  // Use RPC for transactional create with lines
  const { data: newId, error: rpcErr } = await supabase.rpc('create_bill_with_lines', {
    bill_data: {
      vendor_id: data.vendor_id,
      bill_number: data.bill_number,
      bill_date: data.bill_date,
      due_date: data.due_date,
      job_id: data.job_id,
      work_order_id: data.work_order_id,
      subtotal: data.subtotal,
      tax_amount: data.tax_amount,
      total: data.total,
      created_by_user_id: req.session.userId,
    },
    lines: data.lines.map((li, idx) => ({
      description: li.description,
      quantity: li.quantity,
      unit: null,
      unit_price: li.unit_price,
      line_total: lineTotal(li),
      account_id: li.account_id,
      sort_order: idx,
    })),
  });
  if (rpcErr) throw rpcErr;

  // RPC doesn't persist notes (column-list mismatch); patch separately if present.
  if (data.notes != null) {
    const { error: noteErr } = await supabase
      .from('bills')
      .update({ notes: data.notes })
      .eq('id', newId);
    if (noteErr) throw noteErr;
  }

  try {
    await writeAudit({
      entityType: 'bill', entityId: newId, action: 'create',
      before: null,
      after: { status: 'draft', total: data.total },
      source: 'user', userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `Bill draft created.`);
  res.redirect(`/bills/${newId}`);
});

router.get('/:id', async (req, res) => {
  const bill = await loadBill(req.params.id);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  res.render('bills/show', { title: `Bill #${bill.id}`, activeNav: 'bills', bill });
});

router.get('/:id/edit', async (req, res) => {
  const bill = await loadBill(req.params.id);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status !== 'draft') {
    setFlash(req, 'error', `Bill is "${bill.status}" — cannot edit.`);
    return res.redirect(`/bills/${bill.id}`);
  }
  const { vendors, expenseAccounts } = await loadVendorsAndAccounts();
  res.render('bills/edit', {
    title: `Edit bill #${bill.id}`, activeNav: 'bills',
    bill, vendors, expenseAccounts, errors: {}
  });
});

router.post('/:id', async (req, res) => {
  const existing = await loadBill(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (existing.status !== 'draft') {
    setFlash(req, 'error', `Bill is "${existing.status}" — cannot edit.`);
    return res.redirect(`/bills/${existing.id}`);
  }
  const { vendors, expenseAccounts } = await loadVendorsAndAccounts();
  const { errors, data } = await validateBill(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('bills/edit', {
      title: `Edit bill #${existing.id}`, activeNav: 'bills',
      bill: { ...existing, ...data }, vendors, expenseAccounts, errors
    });
  }

  // Transactional update via RPC: rewrites header + lines atomically.
  const lineRows = data.lines.map((li, idx) => ({
    account_id: li.account_id,
    description: li.description,
    quantity: li.quantity,
    unit_price: li.unit_price,
    line_total: lineTotal(li),
    sort_order: idx,
  }));
  const { error: rpcErr } = await supabase.rpc('update_bill_with_lines', {
    bill_id: parseInt(existing.id, 10),
    bill_data: {
      vendor_id: data.vendor_id,
      job_id: data.job_id,
      work_order_id: data.work_order_id,
      bill_number: data.bill_number,
      subtotal: data.subtotal,
      tax_amount: data.tax_amount,
      total: data.total,
      due_date: data.due_date,
      bill_date: data.bill_date,
      notes: data.notes,
    },
    lines: lineRows,
  });
  if (rpcErr) throw rpcErr;

  // RPC does not audit updates — write a separate audit row.
  try {
    const { error: auditErr } = await supabase.from('audit_logs').insert({
      entity_type: 'bill',
      entity_id: existing.id,
      action: 'update',
      before_json: { total: existing.total },
      after_json: { total: data.total },
      source: 'user',
      user_id: req.session.userId,
    });
    if (auditErr) throw auditErr;
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `Bill updated.`);
  res.redirect(`/bills/${existing.id}`);
});

router.post('/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const bill = await loadBill(id);
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status !== 'draft') {
    setFlash(req, 'error', `Bill must be draft to approve. Current: ${bill.status}.`);
    return res.redirect(`/bills/${bill.id}`);
  }

  // RPC: approve_bill handles status + audit
  const { error: rpcErr } = await supabase.rpc('approve_bill', {
    bill_id: id,
    user_id: req.currentUser?.id ?? req.session?.userId ?? null,
  });
  if (rpcErr) throw rpcErr;

  // Post JE: DR Expense per line / CR AP
  try {
    await posting.postBillApproved(bill, bill.lines, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (bill approve) — continuing:', e.message);
  }

  setFlash(req, 'success', `Bill approved and posted to GL.`);
  res.redirect(`/bills/${bill.id}`);
});

router.post('/:id/pay', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: bill, error: findErr } = await supabase
    .from('bills')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status !== 'approved') {
    setFlash(req, 'error', `Bill must be approved before paying. Current: ${bill.status}.`);
    return res.redirect(`/bills/${bill.id}`);
  }
  let amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) amount = Number(bill.total) || 0;
  const remaining = Number(bill.total) - (Number(bill.amount_paid) || 0);
  if (amount > remaining) amount = remaining;

  // RPC: pay_bill handles status flip + audit
  const paymentDate = new Date().toISOString().slice(0, 10);
  const { error: rpcErr } = await supabase.rpc('pay_bill', {
    bill_id: id,
    amount,
    payment_date: paymentDate,
    user_id: req.session.userId,
  });
  if (rpcErr) throw rpcErr;

  // Post JE: DR AP / CR Cash
  try {
    if (amount > 0) await posting.postBillPaid(bill, amount, { userId: req.session.userId });
  } catch (e) {
    console.error('JE post failed (bill pay) — continuing:', e.message);
  }

  const isFullyPaid = amount >= remaining;
  if (isFullyPaid) {
    setFlash(req, 'success', `Bill paid in full.`);
  } else {
    const newBalance = remaining - amount;
    setFlash(req, 'success', `Partial payment $${amount.toFixed(2)} recorded. Balance: $${newBalance.toFixed(2)}.`);
  }
  res.redirect(`/bills/${bill.id}`);
});

router.post('/:id/void', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: bill, error: findErr } = await supabase
    .from('bills')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (bill.status === 'paid') {
    setFlash(req, 'error', `Cannot void a paid bill.`);
    return res.redirect(`/bills/${bill.id}`);
  }

  // RPC: void_bill handles status flip + audit row
  const { error: rpcErr } = await supabase.rpc('void_bill', {
    bill_id: id,
    user_id: req.currentUser?.id ?? req.session?.userId ?? null,
  });
  if (rpcErr) throw rpcErr;
  // Reverse journal entry if bill was previously approved
  try {
    const posting = require('../services/accounting-posting');
    const { data: bill } = await supabase.from('bills').select('id, bill_number, total, tax_amount').eq('id', id).single();
    const { data: lines } = await supabase.from('bill_lines').select('line_total, description, account_id').eq('bill_id', id);
    await posting.postBillVoid(bill, lines || [], { userId: req.currentUser?.id });
  } catch(e) { console.warn('[bills] JE reversal on void failed:', e.message); }
  setFlash(req, 'success', 'Bill voided.');
  res.redirect(`/bills/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: bill, error: findErr } = await supabase
    .from('bills')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!bill) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Bill not found.' });
  if (!['draft', 'void'].includes(bill.status)) {
    setFlash(req, 'error', `Cannot delete bill in status "${bill.status}".`);
    return res.redirect(`/bills/${id}`);
  }
  const { error: delLineErr } = await supabase.from('bill_lines').delete().eq('bill_id', id);
  if (delLineErr) throw delLineErr;
  const { error: delErr } = await supabase.from('bills').delete().eq('id', id);
  if (delErr) throw delErr;

  try {
    await writeAudit({
      entityType: 'bill', entityId: id, action: 'delete',
      before: { status: bill.status },
      after: null,
      source: 'user', userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `Bill deleted.`);
  res.redirect('/bills');
});

module.exports = router;
