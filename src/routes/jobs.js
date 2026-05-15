/**
 * Jobs CRUD (v0.5).
 *
 * Adds: scheduled_date, scheduled_time, assigned_to_user_id.
 * GET /new: if ?customer_id=N is present, auto-prefills the site address
 * fields with the customer's address (overridable in the form).
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();
const PAGE_SIZE = 25;
// R37c: include RPM-native statuses so imported projects are filterable + creatable.
// DB CHECK on jobs.status was relaxed in migration r37b to accept these values.
const VALID_STATUSES = [
  'lead', 'estimating', 'scheduled', 'in_progress', 'complete', 'cancelled',
  'active', 'pending', 'pre-construction'
];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// R40: parse numeric helper for contract_value + total_paid
function emptyToNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? n : null;
}

async function validateJob(body) {
  const errors = {};
  const title = emptyToNull(body.title);
  if (!title) errors.title = 'Title is required.';
  if (title && title.length > 200) errors.title = 'Too long (max 200).';

  const customerId = parseInt(body.customer_id, 10);
  if (!customerId) errors.customer_id = 'Customer is required.';
  else {
    const { data: cust } = await supabase.from('customers').select('id').eq('id', customerId).maybeSingle();
    if (!cust) errors.customer_id = 'Customer not found.';
  }

  const status = emptyToNull(body.status) || 'lead';
  if (!VALID_STATUSES.includes(status)) errors.status = 'Invalid status.';

  const scheduledDate = emptyToNull(body.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    errors.scheduled_date = 'Use YYYY-MM-DD.';
  }
  const scheduledTime = emptyToNull(body.scheduled_time);
  if (scheduledTime && !/^\d{2}:\d{2}$/.test(scheduledTime)) {
    errors.scheduled_time = 'Use HH:MM.';
  }

  const assignedUserId = body.assigned_to_user_id ? parseInt(body.assigned_to_user_id, 10) : null;
  if (assignedUserId) {
    const { data: u } = await supabase.from('users').select('id').eq('id', assignedUserId).eq('active', 1).maybeSingle();
    if (!u) errors.assigned_to_user_id = 'User not found or inactive.';
  }

  return {
    errors,
    data: {
      customer_id: customerId || null,
      title,
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      description: emptyToNull(body.description),
      status,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      assigned_to_user_id: assignedUserId,
      // R40: contract_value + total_paid editable on project form
      contract_value: emptyToNumber(body.contract_value),
      total_paid: emptyToNumber(body.total_paid),
    }
  };
}

function blankJob() {
  return {
    id: null, customer_id: null, title: '',
    address: '', city: '', state: '', zip: '',
    description: '', status: 'lead',
    scheduled_date: '', scheduled_time: '', assigned_to_user_id: null,
  };
}

router.get('/', async (req, res) => {
  // F4: sanitize before interpolating into PostgREST .or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // R37c: projects list — LEFT join customers + include RPM-native `client` field
  // so RPM-imported projects (with customer_id=NULL + free-text client) appear.
  // R37i: jobs has TWO FKs to users (assigned_to_user_id + project_manager_user_id
  // added in r36_projects_layer). PostgREST can't resolve plain `users!left(...)`
  // when multiple FKs exist — must use the FK constraint name explicitly.
  let query = supabase.from('jobs').select(
    'id, title, status, address, city, state, scheduled_date, created_at, customer_id, client, ' +
    'customers!left(name), ' +
    'assigned_to_user_id, ' +
    'users!jobs_assigned_to_user_id_fkey(name)',
    { count: 'exact', head: false }
  );
  let countQuery = supabase.from('jobs').select('*', { count: 'exact', head: true });

  if (q) {
    const like = `%${q}%`;
    // Note: cannot search customers.name via PostgREST .or() when using !left, only on jobs columns.
    query = query.or(`title.ilike.${like},address.ilike.${like},city.ilike.${like},client.ilike.${like}`);
    countQuery = countQuery.or(`title.ilike.${like},address.ilike.${like},city.ilike.${like},client.ilike.${like}`);
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
    countQuery = countQuery.eq('status', status);
  }

  // R37i: also surface the listing-query error (was being silently swallowed —
  // only countQuery.error was checked, masking PostgREST FK-resolution failures).
  const [listResult, countResult] = await Promise.all([
    query.order('created_at', { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (listResult.error) throw listResult.error;
  if (countResult.error) throw countResult.error;
  const jobs = listResult.data;
  const total = listResult.count;

  res.render('jobs/index', {
    title: 'Projects', activeNav: 'projects',
    jobs: (jobs || []).map(j => ({
      ...j,
      // R37c: fall back to RPM `client` (free text) when no customer FK is set.
      customer_name: j.customers?.name || j.client || '—',
      customer_id: j.customer_id,
      assigned_name: j.users?.name
    })),
    q, status, page,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES
  });
});

router.get('/new', async (req, res) => {
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name, address, city, state, zip').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  if (!customers || customers.length === 0) {
    setFlash(req, 'error', 'You need a customer before you can create a project.');
    return res.redirect('/customers/new');
  }
  const job = blankJob();
  const presetCustomerId = parseInt(req.query.customer_id, 10);
  if (presetCustomerId) {
    const c = customers.find(x => x.id === presetCustomerId);
    if (c) {
      job.customer_id = c.id;
      job.address = c.address || '';
      job.city = c.city || '';
      job.state = c.state || '';
      job.zip = c.zip || '';
    }
  }
  res.render('jobs/new', {
    title: 'New project', activeNav: 'projects',
    job, customers: customers || [], users: users || [], errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/', async (req, res) => {
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name, address, city, state, zip').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  const { errors, data } = await validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/new', {
      title: 'New project', activeNav: 'projects',
      job: { id: null, ...data }, customers: customers || [], users: users || [], errors, statuses: VALID_STATUSES
    });
  }
  const { data: newJob, error: insertError } = await supabase
    .from('jobs')
    .insert({
      customer_id: data.customer_id, title: data.title,
      address: data.address, city: data.city, state: data.state, zip: data.zip,
      description: data.description, status: data.status,
      scheduled_date: data.scheduled_date, scheduled_time: data.scheduled_time,
      assigned_to_user_id: data.assigned_to_user_id
    })
    .select()
    .single();
  if (insertError) throw insertError;
  setFlash(req, 'success', `Project "${data.title}" created.`);
  res.redirect(`/projects/${newJob.id}`);
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  // R37i: jobs has TWO FKs to users (assigned_to_user_id + project_manager_user_id from r36).
  // Use explicit FK constraint name on users embed to avoid ambiguity error.
  const { data: job, error: jError } = await supabase
    .from('jobs')
    .select('*, customers!left(id, name, email, phone, address, city, state, zip), users!jobs_assigned_to_user_id_fkey(name)')
    .eq('id', id)
    .maybeSingle();
  if (jError) throw jError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  // Flatten nested data to match view expectations
  job.customer_name = job.customers?.name;
  job.customer_email = job.customers?.email;
  job.customer_phone = job.customers?.phone;
  job.assigned_name = job.users?.name;

  // D-007: financial roll-up from v_job_financials. View aggregates contract,
  // change orders, vendor commitments, and posted bills server-side.
  const { data: fin } = await supabase
    .from('v_job_financials')
    .select('*')
    .eq('job_id', id)
    .maybeSingle();
  const financials = fin || {
    contract_value: job.contract_value || 0,
    budget_mode: job.budget_mode || 'manual',
    revenue_projected: 0, revenue_billed: 0,
    cost_committed: 0, cost_actual: 0,
    profit_projected: 0,
    progress_percentage: job.progress_percentage || 0,
  };

  // R37n: load vendor_invoices + project_contractors (RPM-style data) alongside
  // FORGE-native tables. Plymouth Square (and future RPM imports) carry 200+
  // vendor invoices that need to render on the project show page.
  const [
    { data: workOrders },
    { data: changeOrders },
    { data: lineItems },
    { data: members },
    { data: vendors },
    { data: users },
    { data: vendorInvoices },
    { data: projectContractors },
    { data: payments },
    { data: sovItems },
    { data: decisions },
    { data: rfps },
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select('id, display_number, wo_number_main, wo_number_sub, parent_wo_id, status, scheduled_date, unit_number, assigned_to, completed_date, created_at')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .order('wo_number_sub', { ascending: true }),
    supabase
      .from('change_orders')
      .select('id, description, vendor_amount, customer_amount, status, approved_by_user_id, created_at, vendors!left(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('job_vendor_line_items')
      .select('id, description, quantity, unit_cost, sort_order, vendor_id, vendors!left(name)')
      .eq('job_id', id)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('job_members')
      .select('id, role, user_id, users!inner(name, email)')
      .eq('job_id', id)
      .order('id', { ascending: true }),
    supabase.from('vendors').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
    supabase
      .from('vendor_invoices')
      .select('id, amount, description, invoice_number, vendor_id, created_at, vendors!left(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('project_contractors')
      .select('id, vendor_id, contract_amount, contract_notes, vendors!left(name)')
      .eq('job_id', id),
    supabase
      .from('project_payments')
      .select('*')
      .eq('job_id', id)
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('project_sov_items')
      .select('*')
      .eq('job_id', id)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('project_decisions')
      .select('*, users!project_decisions_assigned_to_user_id_fkey(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('project_rfps')
      .select('*')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .then(r => r)
      .catch(function() { return { data: [] }; }),
  ]);

  const paymentTotal = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);

  // Resolve approver names for change orders (avoid ambiguous users FK alias).
  const approverIds = Array.from(new Set((changeOrders || []).map(co => co.approved_by_user_id).filter(Boolean)));
  let approverMap = {};
  if (approverIds.length) {
    const { data: approvers } = await supabase.from('users').select('id, name').in('id', approverIds);
    (approvers || []).forEach(u => { approverMap[u.id] = u.name; });
  }

  // Project manager lookup (uses denormalized FK on jobs.project_manager_user_id)
  let projectManager = null;
  if (job.project_manager_user_id) {
    const { data: pm } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', job.project_manager_user_id)
      .maybeSingle();
    projectManager = pm;
  }

  // Load RFP line items for each RFP
  let rfpItemsMap = {};
  if (rfps && rfps.length) {
    try {
      const rfpIds = rfps.map(r => r.id);
      const { data: allItems } = await supabase
        .from('rfp_line_items')
        .select('*')
        .in('rfp_id', rfpIds)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });
      (allItems || []).forEach(item => {
        (rfpItemsMap[item.rfp_id] = rfpItemsMap[item.rfp_id] || []).push(item);
      });
    } catch (e) {
      console.warn('[rfp] could not load line items (table may not exist yet):', e.message);
    }
  }

  // R37n: aggregate vendor_invoices by vendor for the vendor-spend table.
  // Each group has running total + per-invoice list. Orphan invoices (no vendor)
  // get grouped under "Unknown vendor" so they don't disappear from the view.
  const invoicesByVendor = {};
  (vendorInvoices || []).forEach(vi => {
    const vKey = vi.vendor_id || 0;
    const vName = vi.vendors?.name || 'Unknown vendor';
    if (!invoicesByVendor[vKey]) {
      invoicesByVendor[vKey] = { vendor_id: vKey, vendor_name: vName, invoices: [], total: 0 };
    }
    invoicesByVendor[vKey].invoices.push({
      id: vi.id,
      amount: Number(vi.amount) || 0,
      description: vi.description || '',
      invoice_number: vi.invoice_number || '',
      created_at: vi.created_at,
    });
    invoicesByVendor[vKey].total += Number(vi.amount) || 0;
  });
  const vendorSpend = Object.values(invoicesByVendor).sort((a, b) => b.total - a.total);
  const vendorInvoiceGrandTotal = vendorSpend.reduce((s, v) => s + v.total, 0);

  // D-036: merge contract_amount from project_contractors into vendorSpend
  const contractorMap = {};
  (projectContractors || []).forEach(pc => {
    if (pc.vendor_id) contractorMap[pc.vendor_id] = { contract_amount: pc.contract_amount || 0, contract_notes: pc.contract_notes || '' };
  });
  vendorSpend.forEach(vs => {
    const c = contractorMap[vs.vendor_id];
    vs.contract_amount = c ? Number(c.contract_amount) : 0;
    vs.contract_notes = c ? c.contract_notes : '';
    vs.remaining = Math.max(0, vs.contract_amount - vs.total);
  });

  res.render('jobs/show', {
    title: job.title, activeNav: 'projects',
    job, financials, projectManager,
    workOrders: workOrders || [],
    vendors: vendors || [],
    users: users || [],
    changeOrders: (changeOrders || []).map(co => ({
      ...co,
      vendor_name: co.vendors?.name,
      approver_name: approverMap[co.approved_by_user_id] || null,
    })),
    lineItems: (lineItems || []).map(li => ({
      ...li,
      vendor_name: li.vendors?.name,
      total_cost: Number(li.quantity || 0) * Number(li.unit_cost || 0),
    })),
    members: (members || []).map(m => ({
      ...m,
      user_name: m.users?.name,
      user_email: m.users?.email,
    })),
    // R37n: RPM-style vendor invoice rollup.
    vendorSpend,
    vendorInvoiceGrandTotal,
    vendorInvoiceCount: (vendorInvoices || []).length,
    projectContractors: (projectContractors || []).map(pc => ({
      id: pc.id,
      vendor_id: pc.vendor_id,
      vendor_name: pc.vendors?.name || '—',
    })),
    // D-024a: customer payment ledger
    payments: (payments || []).map(p => ({ ...p })),
    paymentTotal: paymentTotal || 0,
    // D-024b: Schedule of Values
    sovItems: sovItems || [],
    sovTotalScheduled: (sovItems || []).reduce((s, i) => s + Number(i.scheduled_value || 0), 0),
    sovTotalPrev: (sovItems || []).reduce((s, i) => s + Number(i.previous_billed || 0), 0),
    sovTotalCurrent: (sovItems || []).reduce((s, i) => s + Number(i.current_billed || 0), 0),
    sovFmt: function(n) { const num = Number(n); return isFinite(num) ? num.toFixed(2) : '0.00'; },
    // D-024c: RFI / decision log
    decisions: (decisions || []).map(function(d) {
      var usr = d.users || {};
      return { ...d, assigned_to_name: usr.name || null };
    }),
    // D-093: RFP / bid comparison
    rfps: rfps || [],
    rfpItemsMap,
  });
});

router.get('/:id/edit', async (req, res) => {
  const id = req.params.id;
  const [{ data: job }, { data: customers }, { data: users }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', id).maybeSingle(),
    supabase.from('customers').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  res.render('jobs/edit', {
    title: `Edit ${job.title}`, activeNav: 'projects',
    job, customers: customers || [], users: users || [], errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: job, error: findError } = await supabase.from('jobs').select('id, title').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  const { errors, data } = await validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/edit', {
      title: `Edit ${job.title}`, activeNav: 'projects',
      job: { id: job.id, ...data }, customers: customers || [], users: users || [], errors, statuses: VALID_STATUSES
    });
  }
  // R40: contract_value + total_paid are optional on edit. If not present in
  // form body, leave the existing values untouched (don't overwrite to 0).
  const updatePatch = {
    customer_id: data.customer_id, title: data.title,
    address: data.address, city: data.city, state: data.state, zip: data.zip,
    description: data.description, status: data.status,
    scheduled_date: data.scheduled_date, scheduled_time: data.scheduled_time,
    assigned_to_user_id: data.assigned_to_user_id,
    updated_at: new Date().toISOString()
  };
  if (data.contract_value !== null) updatePatch.contract_value = data.contract_value;
  if (data.total_paid !== null) updatePatch.total_paid = data.total_paid;
  const { error: updateError } = await supabase
    .from('jobs')
    .update(updatePatch)
    .eq('id', id);
  if (updateError) throw updateError;
  setFlash(req, 'success', `Project "${data.title}" updated.`);
  res.redirect(`/projects/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = req.params.id;
  const { data: job, error: findError } = await supabase.from('jobs').select('id, title').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  const { count: woCount, error: woCountError } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('job_id', id);
  if (woCountError) throw woCountError;
  if (woCount) {
    setFlash(req, 'error', `Cannot delete "${job.title}" — it has ${woCount} work order(s).`);
    return res.redirect(`/projects/${id}`);
  }
  const { error: deleteError } = await supabase.from('jobs').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', `Project "${job.title}" deleted.`);
  res.redirect('/projects');
});

// ============================================================
// D-007 sub-resources: change orders, vendor line items, members.
// All POST/DELETE endpoints respond with the freshly-rendered section
// partial so HTMX hx-swap="outerHTML" gets a self-contained DOM block.
// ============================================================

const VALID_CO_STATUSES = ['pending', 'approved', 'rejected', 'invoiced'];
const VALID_ROLES = ['owner', 'manager', 'member', 'contractor'];

async function loadChangeOrders(jobId) {
  const { data, error } = await supabase
    .from('change_orders')
    .select('id, description, vendor_amount, customer_amount, status, approved_by_user_id, created_at, vendors!left(name)')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const list = data || [];
  const approverIds = Array.from(new Set(list.map(co => co.approved_by_user_id).filter(Boolean)));
  let approverMap = {};
  if (approverIds.length) {
    const { data: approvers, error: approverError } = await supabase.from('users').select('id, name').in('id', approverIds);
    if (approverError) throw approverError;
    (approvers || []).forEach(u => { approverMap[u.id] = u.name; });
  }
  return list.map(co => ({ ...co, vendor_name: co.vendors?.name, approver_name: approverMap[co.approved_by_user_id] || null }));
}

async function loadLineItems(jobId) {
  const { data, error } = await supabase
    .from('job_vendor_line_items')
    .select('id, description, quantity, unit_cost, sort_order, vendor_id, vendors!left(name)')
    .eq('job_id', jobId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(li => ({
    ...li,
    vendor_name: li.vendors?.name,
    total_cost: Number(li.quantity || 0) * Number(li.unit_cost || 0),
  }));
}

async function loadMembers(jobId) {
  const { data, error } = await supabase
    .from('job_members')
    .select('id, role, user_id, users!inner(name, email)')
    .eq('job_id', jobId)
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(m => ({ ...m, user_name: m.users?.name, user_email: m.users?.email }));
}

async function loadVendors() {
  const { data, error } = await supabase.from('vendors').select('id, name').order('name');
  if (error) throw error;
  return data || [];
}

async function loadActiveUsers() {
  const { data, error } = await supabase.from('users').select('id, name, email').eq('active', 1).order('name');
  if (error) throw error;
  return data || [];
}

// ---------- Change orders ----------

router.get('/:id/change-orders', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

router.post('/:id/change-orders', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const description = emptyToNull(req.body.description);
  if (!description) return res.status(400).send('Description required');
  const vendorId = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) || null : null;
  const vendorAmt = req.body.vendor_amount === '' || req.body.vendor_amount == null ? null : Number(req.body.vendor_amount);
  const custAmt = req.body.customer_amount === '' || req.body.customer_amount == null ? null : Number(req.body.customer_amount);
  const { error } = await supabase.from('change_orders').insert({
    job_id: parseInt(id, 10),
    vendor_id: vendorId,
    description,
    vendor_amount: vendorAmt,
    customer_amount: custAmt,
    status: 'pending',
  });
  if (error) throw error;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

router.post('/:id/change-orders/:coId/approve', async (req, res) => {
  const { id, coId } = req.params;
  const userId = req.session && req.session.userId ? req.session.userId : null;
  const { error } = await supabase
    .from('change_orders')
    .update({
      status: 'approved',
      approved_by_user_id: userId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', coId)
    .eq('job_id', id);
  if (error) throw error;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

router.post('/:id/change-orders/:coId/reject', async (req, res) => {
  const { id, coId } = req.params;
  const userId = req.session && req.session.userId ? req.session.userId : null;
  const { error } = await supabase
    .from('change_orders')
    .update({
      status: 'rejected',
      approved_by_user_id: userId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', coId)
    .eq('job_id', id);
  if (error) throw error;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

// ---------- Vendor line items ----------

router.get('/:id/line-items', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const [lineItems, vendors] = await Promise.all([loadLineItems(id), loadVendors()]);
  res.render('jobs/_line_items_table', { job: { id }, lineItems, vendors });
});

router.post('/:id/line-items', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const description = emptyToNull(req.body.description);
  if (!description) return res.status(400).send('Description required');
  const vendorId = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) || null : null;
  const quantity = req.body.quantity === '' || req.body.quantity == null ? 1 : Number(req.body.quantity);
  const unitCost = req.body.unit_cost === '' || req.body.unit_cost == null ? 0 : Number(req.body.unit_cost);
  // Compute next sort_order so new items append.
  const { data: maxRow } = await supabase
    .from('job_vendor_line_items')
    .select('sort_order')
    .eq('job_id', id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = (maxRow && Number.isFinite(Number(maxRow.sort_order)) ? Number(maxRow.sort_order) : 0) + 1;
  const { error } = await supabase.from('job_vendor_line_items').insert({
    job_id: parseInt(id, 10),
    vendor_id: vendorId,
    description,
    quantity,
    unit_cost: unitCost,
    sort_order: nextSort,
  });
  if (error) throw error;
  const [lineItems, vendors] = await Promise.all([loadLineItems(id), loadVendors()]);
  res.render('jobs/_line_items_table', { job: { id }, lineItems, vendors });
});

router.delete('/:id/line-items/:itemId', async (req, res) => {
  const { id, itemId } = req.params;
  const { error } = await supabase
    .from('job_vendor_line_items')
    .delete()
    .eq('id', itemId)
    .eq('job_id', id);
  if (error) throw error;
  const [lineItems, vendors] = await Promise.all([loadLineItems(id), loadVendors()]);
  res.render('jobs/_line_items_table', { job: { id }, lineItems, vendors });
});

// ---------- Vendor Invoices ----------

router.post('/:id/vendor-invoices', async (req, res) => {
  const id = req.params.id;
  const jobId = parseInt(id, 10);
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const vendorName = emptyToNull(req.body.vendor_name);
  if (!vendorName) return res.status(400).send('Vendor name required');
  const amount = req.body.amount === '' || req.body.amount == null ? null : Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).send('Valid amount required');

  // R37q-fix (GPT G-010 P0): vendor_invoices.vendor_id is FK, not vendor_name.
  // Resolve vendor by exact-name match (case-insensitive), creating if missing.
  // Also auto-link to project_contractors so the new vendor shows up in the
  // datalist on next render.
  let vendorId = null;
  const { data: existing } = await supabase
    .from('vendors')
    .select('id')
    .ilike('name', vendorName)
    .maybeSingle();
  if (existing) {
    vendorId = existing.id;
  } else {
    const { data: created, error: cErr } = await supabase
      .from('vendors')
      .insert({ name: vendorName, mock: 0 })
      .select('id')
      .single();
    if (cErr) throw cErr;
    vendorId = created.id;
  }
  // Ensure project_contractor link exists (idempotent).
  const { error: contractorLinkError } = await supabase
    .from('project_contractors')
    .upsert({ job_id: jobId, vendor_id: vendorId }, { onConflict: 'job_id,vendor_id', ignoreDuplicates: true });
  if (contractorLinkError) throw contractorLinkError;

  const { error } = await supabase.from('vendor_invoices').insert({
    job_id: jobId,
    vendor_id: vendorId,
    invoice_number: emptyToNull(req.body.invoice_number),
    description: emptyToNull(req.body.description),
    amount,
  });
  if (error) throw error;
  setFlash(req, 'success', `Vendor invoice $${amount.toFixed(2)} added for ${vendorName}.`);
  res.redirect(`/projects/${id}`);
});

// ---------- Customer Payments ----------

router.get('/:id/payments', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const { data: payments, error: pErr } = await supabase
    .from('project_payments')
    .select('*')
    .eq('job_id', id)
    .order('payment_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (pErr) throw pErr;
  const paymentTotal = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  res.render('jobs/_payments_timeline', {
    layout: false, jobId: id, payments: payments || [],
    paymentTotal, fmt,
  });
});

router.post('/:id/payments', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).send('Valid amount required');
  const { error } = await supabase.from('project_payments').insert({
    job_id: parseInt(id, 10),
    amount,
    payment_date: req.body.payment_date || new Date().toISOString().slice(0,10),
    method: req.body.method || 'check',
    reference: emptyToNull(req.body.reference),
    notes: emptyToNull(req.body.notes),
    received_by_user_id: req.session.userId || null,
  });
  if (error) throw error;
  // Update jobs.total_paid
  const { data: payments, error: paymentsErr } = await supabase.from('project_payments').select('amount').eq('job_id', id);
  if (paymentsErr) throw paymentsErr;
  const total = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const { error: totalErr } = await supabase.from('jobs').update({ total_paid: total }).eq('id', id);
  if (totalErr) throw totalErr;
  setFlash(req, 'success', `Payment of $${amount.toFixed(2)} recorded.`);
  res.redirect(`/projects/${id}`);
});

// ---------- SOV (D-024b) ----------

router.post('/:id/sov-items', async (req, res) => {
  const id = req.params.id;
  const { data: job, error: jobError } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).send('Project not found');
  const { error } = await supabase.from('project_sov_items').insert({
    job_id: parseInt(id, 10),
    code: req.body.code || null,
    description: req.body.description,
    scheduled_value: Number(req.body.scheduled_value) || 0,
    percent_complete: Number(req.body.percent_complete) || 0,
    retainage_rate: Number(req.body.retainage_rate) || 0,
    sort_order: 0,
  });
  if (error) throw error;
  setFlash(req, 'success', 'SOV item added.');
  res.redirect('/projects/' + id);
});

router.post('/:id/sov-items/:itemId/delete', async (req, res) => {
  const { error } = await supabase.from('project_sov_items').delete().eq('id', req.params.itemId).eq('job_id', req.params.id);
  if (error) {
    setFlash(req, 'error', 'SOV item delete failed: ' + error.message);
    return res.redirect('/projects/' + req.params.id);
  }
  setFlash(req, 'success', 'SOV item deleted.');
  res.redirect('/projects/' + req.params.id);
});

// D-024b-fix: inline SOV field update
router.post('/:id/sov-items/:itemId/update', async (req, res) => {
  const { field, value } = req.body;
  const allowedFields = ['current_billed', 'percent_complete', 'retainage_rate'];
  if (!allowedFields.includes(field)) return res.status(400).send('Invalid field');
  const numVal = parseFloat(value) || 0;
  const clamped = field === 'percent_complete' || field === 'retainage_rate'
    ? Math.min(100, Math.max(0, numVal)) : Math.max(0, numVal);
  const { error } = await supabase.from('project_sov_items').update({ [field]: clamped }).eq('id', req.params.itemId).eq('job_id', req.params.id);
  if (error) { setFlash(req, 'error', 'Update failed: ' + error.message); return res.redirect('/projects/' + req.params.id); }
  setFlash(req, 'success', field.replace(/_/g, ' ') + ' updated to ' + clamped);
  res.redirect('/projects/' + req.params.id);
});

router.post('/:id/draws/generate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: items, error: itemsError } = await supabase.from('project_sov_items').select('*').eq('job_id', id).order('id');
  if (itemsError) throw itemsError;
  if (!items || items.length === 0) { setFlash(req, 'error', 'No SOV items to bill.'); return res.redirect('/projects/' + id); }
  const { data: draws, error: drawsError } = await supabase.from('project_draws').select('draw_number').eq('job_id', id).order('draw_number', { ascending: false }).limit(1);
  if (drawsError) throw drawsError;
  const drawNum = (draws && draws.length > 0 ? draws[0].draw_number : 0) + 1;
  const { error: drawInsertError } = await supabase.from('project_draws').insert({ job_id: id, draw_number: drawNum, status: 'draft', line_snapshot: JSON.stringify(items) });
  if (drawInsertError) {
    setFlash(req, 'error', 'Draw generation failed: ' + drawInsertError.message);
    return res.redirect('/projects/' + id);
  }
  for (const item of items) {
    if (item.current_billed > 0) {
      const { error: itemUpdateError } = await supabase.from('project_sov_items').update({
        previous_billed: Number(item.previous_billed) + Number(item.current_billed),
        current_billed: 0,
      }).eq('id', item.id);
      if (itemUpdateError) throw itemUpdateError;
    }
  }
  setFlash(req, 'success', 'Draw #' + drawNum + ' generated.');
  res.redirect('/projects/' + id);
});

// ---------- Decisions (D-024c) ----------

router.post('/:id/decisions', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const decisionTypes = new Set(['rfi', 'submittal', 'field_decision']);
  const decisionType = decisionTypes.has(req.body.decision_type) ? req.body.decision_type : 'rfi';
  const question = String(req.body.question || '').trim();
  if (!question) {
    setFlash(req, 'error', 'Question / description is required.');
    return res.redirect('/projects/' + id);
  }
  const { error } = await supabase.from('project_decisions').insert({
    job_id: parseInt(id, 10),
    decision_type: decisionType,
    question,
    due_date: req.body.due_date || null,
    assigned_to_user_id: req.body.assigned_to_user_id ? parseInt(req.body.assigned_to_user_id, 10) : null,
    created_by_user_id: req.session.userId || null,
  });
  if (error) throw error;
  setFlash(req, 'success', 'Decision item added.');
  res.redirect('/projects/' + id);
});

router.post('/:id/decisions/:dId/answer', async (req, res) => {
  const statuses = new Set(['open', 'answered', 'approved', 'rejected', 'closed']);
  const nextStatus = statuses.has(req.body.status) ? req.body.status : 'answered';
  const { error, count } = await supabase.from('project_decisions').update({
    answer: String(req.body.answer || '').trim() || null,
    status: nextStatus,
    answered_at: new Date(),
  }, { count: 'exact' }).eq('id', req.params.dId).eq('job_id', req.params.id);
  if (error) throw error;
  if (!count) {
    setFlash(req, 'error', 'Decision item not found.');
    return res.redirect('/projects/' + req.params.id);
  }
  setFlash(req, 'success', 'Decision updated.');
  res.redirect('/projects/' + req.params.id);
});

// ---------- Excel export (D-024d) ----------

router.get('/:id/export.xlsx', async (req, res) => {
  const id = req.params.id;
  const ExcelJS = require('exceljs');
  const { data: job, error: jobError } = await supabase.from('jobs').select('*, customers!left(name, email)').eq('id', id).maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).send('Project not found');
  const [woRes, membersRes, vendorsRes] = await Promise.all([
    supabase.from('work_orders').select('display_number, description, status, scheduled_date, unit_number').eq('job_id', id).order('created_at'),
    supabase.from('job_members').select('role, users!inner(name, email)').eq('job_id', id),
    supabase.from('project_contractors').select('contract_amount, vendors!left(name)').eq('job_id', id),
  ]);
  for (const result of [woRes, membersRes, vendorsRes]) {
    if (result.error) throw result.error;
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FORGE';
  const sh1 = wb.addWorksheet('Project');
  sh1.addRow(['Field', 'Value']);
  sh1.addRow(['Project', job.title]);
  sh1.addRow(['Customer', job.customers?.name || job.client || '']);
  sh1.addRow(['Contract Value', job.contract_value || 0]);
  const sh2 = wb.addWorksheet('Work Orders');
  sh2.addRow(['Display #', 'Description', 'Status', 'Scheduled', 'Unit']);
  (woRes.data || []).forEach(function(wo) { sh2.addRow([wo.display_number, wo.description, wo.status, wo.scheduled_date, wo.unit_number]); });
  const sh3 = wb.addWorksheet('Team');
  sh3.addRow(['Name', 'Email', 'Role']);
  (membersRes.data || []).forEach(function(m) { sh3.addRow([m.users?.name, m.users?.email, m.role]); });
  const sh4 = wb.addWorksheet('Vendors');
  sh4.addRow(['Vendor', 'Contract Amount']);
  (vendorsRes.data || []).forEach(function(v) { sh4.addRow([v.vendors?.name, v.contract_amount]); });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + id + '-export.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Members ----------

router.get('/:id/members', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const [members, users] = await Promise.all([loadMembers(id), loadActiveUsers()]);
  res.render('jobs/_members_list', { job: { id }, members, users });
});

router.post('/:id/members', async (req, res) => {
  const id = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id').eq('id', id).maybeSingle();
  if (!job) return res.status(404).send('Project not found');
  const userId = parseInt(req.body.user_id, 10);
  if (!userId) return res.status(400).send('user_id required');
  const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'member';
  // UNIQUE(job_id, user_id) — if already a member, just update role.
  const { data: existing } = await supabase
    .from('job_members')
    .select('id')
    .eq('job_id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase.from('job_members').update({ role }).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('job_members').insert({
      job_id: parseInt(id, 10),
      user_id: userId,
      role,
    });
    if (error) throw error;
  }
  const [members, users] = await Promise.all([loadMembers(id), loadActiveUsers()]);
  res.render('jobs/_members_list', { job: { id }, members, users });
});

router.delete('/:id/members/:memberId', async (req, res) => {
  const { id, memberId } = req.params;
  const { error } = await supabase
    .from('job_members')
    .delete()
    .eq('id', memberId)
    .eq('job_id', id);
  if (error) throw error;
  const [members, users] = await Promise.all([loadMembers(id), loadActiveUsers()]);
  res.render('jobs/_members_list', { job: { id }, members, users });
});

module.exports = router;
