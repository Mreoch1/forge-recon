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
const VALID_STATUSES = ['lead', 'estimating', 'scheduled', 'in_progress', 'complete', 'cancelled'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
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

  let query = supabase.from('jobs').select('id, title, status, address, city, state, scheduled_date, created_at, customer_id, customers!inner(name), assigned_to_user_id, users!left(name)', { count: 'exact', head: false });
  let countQuery = supabase.from('jobs').select('*', { count: 'exact', head: true });

  if (q) {
    const like = `%${q}%`;
    query = query.or(`title.ilike.${like},address.ilike.${like},city.ilike.${like},customers.name.ilike.${like}`);
    countQuery = countQuery.or(`title.ilike.${like},address.ilike.${like},city.ilike.${like},customers.name.ilike.${like}`);
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
    countQuery = countQuery.eq('status', status);
  }

  const [{ data: jobs, count: total }, { error }] = await Promise.all([
    query.order('created_at', { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (error) throw error;

  res.render('jobs/index', {
    title: 'Projects', activeNav: 'projects',
    jobs: (jobs || []).map(j => ({ ...j, customer_name: j.customers?.name, customer_id: j.customer_id, assigned_name: j.users?.name })),
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
  const { data: job, error: jError } = await supabase
    .from('jobs')
    .select('*, customers!left(id, name, email, phone, address, city, state, zip), users!left(name)')
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

  const [
    { data: workOrders },
    { data: changeOrders },
    { data: lineItems },
    { data: members },
    { data: vendors },
    { data: users },
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select('id, display_number, wo_number_main, wo_number_sub, parent_wo_id, status, scheduled_date, created_at')
      .eq('job_id', id)
      .order('wo_number_main', { ascending: true })
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
  ]);

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
  const { error: updateError } = await supabase
    .from('jobs')
    .update({
      customer_id: data.customer_id, title: data.title,
      address: data.address, city: data.city, state: data.state, zip: data.zip,
      description: data.description, status: data.status,
      scheduled_date: data.scheduled_date, scheduled_time: data.scheduled_time,
      assigned_to_user_id: data.assigned_to_user_id,
      updated_at: new Date().toISOString()
    })
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
  const { count: woCount } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('job_id', id);
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
  const { data } = await supabase
    .from('change_orders')
    .select('id, description, vendor_amount, customer_amount, status, approved_by_user_id, created_at, vendors!left(name)')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  const list = data || [];
  const approverIds = Array.from(new Set(list.map(co => co.approved_by_user_id).filter(Boolean)));
  let approverMap = {};
  if (approverIds.length) {
    const { data: approvers } = await supabase.from('users').select('id, name').in('id', approverIds);
    (approvers || []).forEach(u => { approverMap[u.id] = u.name; });
  }
  return list.map(co => ({ ...co, vendor_name: co.vendors?.name, approver_name: approverMap[co.approved_by_user_id] || null }));
}

async function loadLineItems(jobId) {
  const { data } = await supabase
    .from('job_vendor_line_items')
    .select('id, description, quantity, unit_cost, sort_order, vendor_id, vendors!left(name)')
    .eq('job_id', jobId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  return (data || []).map(li => ({
    ...li,
    vendor_name: li.vendors?.name,
    total_cost: Number(li.quantity || 0) * Number(li.unit_cost || 0),
  }));
}

async function loadMembers(jobId) {
  const { data } = await supabase
    .from('job_members')
    .select('id, role, user_id, users!inner(name, email)')
    .eq('job_id', jobId)
    .order('id', { ascending: true });
  return (data || []).map(m => ({ ...m, user_name: m.users?.name, user_email: m.users?.email }));
}

async function loadVendors() {
  const { data } = await supabase.from('vendors').select('id, name').order('name');
  return data || [];
}

async function loadActiveUsers() {
  const { data } = await supabase.from('users').select('id, name, email').eq('active', 1).order('name');
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

