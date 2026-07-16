/**
 * Bills (vendor invoices) CRUD — Supabase SDK.
 *
 * Status flow:  entered -> paid
 *               entered -> void
 *               approved -> void  (with reversing JE)
 *
 * Routes (mounted at /bills under requireManager):
 *   GET   /                       list with vendor filter
 *   GET   /new[?vendor_id=N]      new manual bill
 *   POST  /                       create approved bill
 *   GET   /:id                    show
 *   GET   /:id/edit               edit legacy draft only
 *   POST  /:id                    update legacy draft only
 *   POST  /:id/pay                approved -> paid (full or partial) + post JE (DR AP / CR Cash)
 *   POST  /:id/void               any non-paid -> void (with reversing JE if approved)
 *   POST  /:id/delete             draft or void only
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const posting = require('../services/accounting-posting');
const { writeAudit } = require('../services/audit');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const billPaperwork = require('../services/bill-paperwork');

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
    const { data: v, error: vendorError } = await supabase.from('vendors').select('id').eq('id', vendorId).maybeSingle();
    if (vendorError) throw vendorError;
    if (!v) errors.vendor_id = 'Vendor not found.';
  }

  const billNumber = emptyToNull(body.bill_number);
  const billDate = emptyToNull(body.bill_date);
  if (billDate && !/^\d{4}-\d{2}-\d{2}$/.test(billDate)) errors.bill_date = 'Use YYYY-MM-DD.';
  const dueDate = emptyToNull(body.due_date);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors.due_date = 'Use YYYY-MM-DD.';

  const projectIdRaw = body.project_id || body.job_id;
  const jobId = projectIdRaw ? parseInt(projectIdRaw, 10) : null;
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
    const { data: uc, error: creatorError } = await supabase.from('users').select('name').eq('id', bill.created_by_user_id).maybeSingle();
    if (creatorError) throw creatorError;
    bill.created_by_name = uc?.name || null;
  } else {
    bill.created_by_name = null;
  }
  if (bill.approved_by_user_id) {
    const { data: ua, error: approverError } = await supabase.from('users').select('name').eq('id', bill.approved_by_user_id).maybeSingle();
    if (approverError) throw approverError;
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

  bill.paperwork = { estimates: [], invoices: [] };
  try {
    const { data: estLinks, error: estLinkError } = await supabase
      .from('estimate_line_items')
      .select('estimate_id, estimates!inner(id, status, total, work_order_id)')
      .eq('source_bill_id', bill.id);
    if (estLinkError) throw estLinkError;
    const estById = {};
    (estLinks || []).forEach(row => {
      const est = row.estimates;
      if (est && !estById[est.id]) estById[est.id] = est;
    });
    bill.paperwork.estimates = Object.values(estById);
  } catch (e) {
    bill.paperwork.estimates = [];
  }

  try {
    const { data: invLinks, error: invLinkError } = await supabase
      .from('invoice_line_items')
      .select('invoice_id, invoices!inner(id, status, total, work_order_id)')
      .eq('source_bill_id', bill.id);
    if (invLinkError) throw invLinkError;
    const invById = {};
    (invLinks || []).forEach(row => {
      const inv = row.invoices;
      if (inv && !invById[inv.id]) invById[inv.id] = inv;
    });
    bill.paperwork.invoices = Object.values(invById);
  } catch (e) {
    bill.paperwork.invoices = [];
  }
  return bill;
}

async function approveBillIfNeeded(billId, userId) {
  const bill = await loadBill(billId);
  if (!bill || bill.status !== 'draft') return bill;

  const { error: rpcErr } = await supabase.rpc('approve_bill', {
    bill_id: parseInt(billId, 10),
    user_id: userId || null,
  });
  if (rpcErr) throw rpcErr;

  try {
    await posting.postBillApproved(bill, bill.lines, { userId });
  } catch (e) {
    console.error('JE post failed (bill approve) — continuing:', e.message);
  }
  return loadBill(billId);
}

function blankBill() {
  return {
    id: null, vendor_id: null, bill_number: '', bill_date: '', due_date: '',
    job_id: null, work_order_id: null, tax_amount: 0, notes: '',
    lines: [], subtotal: 0, total: 0
  };
}

async function loadVendorsAndAccounts() {
  const [{ data: vendors, error: vendorsError }, { data: expenseAccounts, error: accountsError }] = await Promise.all([
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
  if (vendorsError) throw vendorsError;
  if (accountsError) throw accountsError;
  return { vendors: vendors || [], expenseAccounts: expenseAccounts || [] };
}

// --- routes ---

router.get('/', async (req, res) => {
  const status = (req.query.status || '').trim();
  const vendorId = parseInt(req.query.vendor_id, 10) || null;
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  let qVendorIds = [];

  if (q) {
    const { data: vendorMatches, error: vendorSearchError } = await supabase
      .from('vendors')
      .select('id')
      .eq('archived', 0)
      .ilike('name', `%${q}%`)
      .limit(100);
    if (vendorSearchError) throw vendorSearchError;
    qVendorIds = (vendorMatches || []).map(v => Number(v.id)).filter(Number.isInteger);
  }

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
  if (q) {
    const like = `%${q}%`;
    const clauses = [`bill_number.ilike.${like}`];
    if (qVendorIds.length) clauses.push(`vendor_id.in.(${qVendorIds.join(',')})`);
    query = query.or(clauses.join(','));
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

  const { data: vendors, error: vendorsError } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('archived', 0)
    .order('name');
  if (vendorsError) throw vendorsError;

  res.render('bills/index', {
    title: 'Bills', activeNav: 'bills',
    bills, vendors: vendors || [], status, vendorId, q, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES
  });
});

// Load bill-linking context in one pass. Completed work orders remain available
// because vendor invoices commonly arrive after the field work is finished.
const BILL_WORK_ORDER_SELECT = `
  id, display_number, status, unit_number, description, job_id,
  jobs!left(title, address, city, state, customers!left(name)),
  customers!left(name, address, city, state)
`;

async function loadProjectsAndWorkOrders({ projectId = null, workOrderId = null } = {}) {
  const selectedProjectId = parseInt(projectId, 10) || null;
  const selectedWorkOrderId = parseInt(workOrderId, 10) || null;
  const [pRes, woRes] = await Promise.all([
    supabase.from('jobs')
      .select('id, title, status')
      .order('id', { ascending: false })
      .limit(1000),
    supabase.from('work_orders')
      .select(BILL_WORK_ORDER_SELECT)
      .neq('status', 'cancelled')
      .order('id', { ascending: false })
      .limit(1000),
  ]);
  if (pRes.error) throw pRes.error;
  if (woRes.error) throw woRes.error;

  const projectRows = [...(pRes.data || [])];
  if (selectedProjectId && !projectRows.some(j => j.id === selectedProjectId)) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, title, status')
      .eq('id', selectedProjectId)
      .maybeSingle();
    if (error) throw error;
    if (data) projectRows.push(data);
  }

  const workOrderRows = [...(woRes.data || [])];
  if (selectedWorkOrderId && !workOrderRows.some(w => w.id === selectedWorkOrderId)) {
    const { data, error } = await supabase
      .from('work_orders')
      .select(BILL_WORK_ORDER_SELECT)
      .eq('id', selectedWorkOrderId)
      .maybeSingle();
    if (error) throw error;
    if (data) workOrderRows.push(data);
  }

  const woIds = workOrderRows.map(w => w.id);
  let invoiceRows = [];
  if (woIds.length) {
    const chunks = [];
    for (let i = 0; i < woIds.length; i += 200) chunks.push(woIds.slice(i, i + 200));
    const invoiceResults = await Promise.all(chunks.map(ids => supabase
      .from('invoices')
      .select('id, status, work_order_id, created_at')
      .in('work_order_id', ids)
      .order('created_at', { ascending: false })));
    invoiceResults.forEach(result => {
      if (result.error) throw result.error;
      invoiceRows.push(...(result.data || []));
    });
  }

  const invoiceByWorkOrder = new Map();
  invoiceRows.forEach(invoice => {
    if (!invoiceByWorkOrder.has(invoice.work_order_id)) {
      invoiceByWorkOrder.set(invoice.work_order_id, invoice);
    }
  });

  const projects = projectRows.map(j => ({
    id: j.id,
    title: j.title || `Project #${j.id}`,
    status: j.status || '',
  }));
  const workOrders = workOrderRows.map(w => ({
    id: w.id,
    display_number: w.display_number,
    status: w.status || '',
    unit_number: w.unit_number || '',
    description: w.description || '',
    job_id: w.job_id || null,
    job_title: w.jobs?.title || '',
    customer_name: w.customers?.name || w.jobs?.customers?.name || '',
    address: [
      w.jobs?.address || w.customers?.address,
      w.jobs?.city || w.customers?.city,
      w.jobs?.state || w.customers?.state,
    ].filter(Boolean).join(', '),
    invoice_id: invoiceByWorkOrder.get(w.id)?.id || null,
    invoice_status: invoiceByWorkOrder.get(w.id)?.status || '',
  }));
  return { projects, workOrders };
}

router.get('/new', async (req, res) => {
  const { vendors, expenseAccounts } = await loadVendorsAndAccounts();
  if (vendors.length === 0) {
    setFlash(req, 'error', 'Add a vendor first.');
    return res.redirect('/vendors/new');
  }
  const { projects, workOrders } = await loadProjectsAndWorkOrders();
  const bill = blankBill();
  const presetVendor = parseInt(req.query.vendor_id, 10);
  if (presetVendor && vendors.some(v => v.id === presetVendor)) bill.vendor_id = presetVendor;

  res.render('bills/new', {
    title: 'New bill', activeNav: 'bills',
    bill, vendors, expenseAccounts, projects, workOrders, errors: {},
    vendorName: presetVendor ? (vendors.find(v => v.id === presetVendor)?.name || '') : ''
  });
});

router.post('/', async (req, res) => {
  const { vendors, expenseAccounts } = await loadVendorsAndAccounts();
  const { errors, data } = await validateBill(req.body);
  if (Object.keys(errors).length) {
    const { projects, workOrders } = await loadProjectsAndWorkOrders({
      projectId: data.job_id,
      workOrderId: data.work_order_id,
    });
    return res.status(400).render('bills/new', {
      title: 'New bill', activeNav: 'bills',
      bill: { id: null, ...data }, vendors, expenseAccounts, projects, workOrders, errors,
      vendorName: data.vendor_id ? (vendors.find(v => String(v.id) === String(data.vendor_id))?.name || '') : ''
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
      status: 'draft',
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
      after: { status: 'approved', total: data.total },
      source: 'user', userId: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  await approveBillIfNeeded(newId, req.session.userId);

  let paperwork = null;
  if (data.work_order_id) {
    try {
      paperwork = await billPaperwork.ensureDraftPaperworkForBill({ billId: newId });
    } catch (e) {
      console.warn('[bills] draft estimate/invoice creation failed:', e.message);
    }
  }

  if (paperwork && !paperwork.skipped) {
    setFlash(req, 'success', `Bill entered. Draft estimate #${paperwork.estimate_id} and invoice #${paperwork.invoice_id} are ready to edit before sending.`);
  } else {
    setFlash(req, 'success', `Bill entered.`);
  }
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
  const { projects, workOrders } = await loadProjectsAndWorkOrders({
    projectId: bill.job_id,
    workOrderId: bill.work_order_id,
  });
  res.render('bills/edit', {
    title: `Edit bill #${bill.id}`, activeNav: 'bills',
    bill, vendors, expenseAccounts, projects, workOrders, errors: {},
    vendorName: bill.vendor_name || (vendors.find(v => String(v.id) === String(bill.vendor_id))?.name || '')
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
    const { projects, workOrders } = await loadProjectsAndWorkOrders({
      projectId: data.job_id || existing.job_id,
      workOrderId: data.work_order_id || existing.work_order_id,
    });
    return res.status(400).render('bills/edit', {
      title: `Edit bill #${existing.id}`, activeNav: 'bills',
      bill: { ...existing, ...data }, vendors, expenseAccounts, projects, workOrders, errors,
      vendorName: data.vendor_id ? (vendors.find(v => String(v.id) === String(data.vendor_id))?.name || '') : ''
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

  if (data.work_order_id) {
    try {
      await billPaperwork.ensureDraftPaperworkForBill({ billId: existing.id });
    } catch (e) {
      console.warn('[bills] draft estimate/invoice sync failed:', e.message);
    }
  }

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
  await approveBillIfNeeded(id, req.session.userId);
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
  let reversalFailed = false;
  try {
    if (bill.status === 'approved') {
      const { data: voidedBill, error: voidedBillErr } = await supabase
        .from('bills')
        .select('id, bill_number, total, tax_amount')
        .eq('id', id)
        .single();
      if (voidedBillErr) throw voidedBillErr;
      const { data: lines, error: lineErr } = await supabase
        .from('bill_lines')
        .select('line_total, description, account_id')
        .eq('bill_id', id);
      if (lineErr) throw lineErr;
      await posting.postBillVoid(voidedBill, lines || [], { userId: req.currentUser?.id ?? req.session?.userId ?? null });
    }
  } catch(e) {
    reversalFailed = true;
    console.warn('[bills] JE reversal on void failed:', e.message);
  }
  setFlash(req, 'success', 'Bill voided.');
  if (reversalFailed) setFlash(req, 'info', 'Bill voided, but the accounting reversal did not post. Review the journal before closing the books.');
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
