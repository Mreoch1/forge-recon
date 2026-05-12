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
  const q = (req.query.q || '').trim();
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
    title: 'Jobs', activeNav: 'jobs',
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
    setFlash(req, 'error', 'You need a customer before you can create a job.');
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
    title: 'New job', activeNav: 'jobs',
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
      title: 'New job', activeNav: 'jobs',
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
  setFlash(req, 'success', `Job "${data.title}" created.`);
  res.redirect(`/jobs/${newJob.id}`);
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: job, error: jError } = await supabase
    .from('jobs')
    .select('*, customers!inner(id, name, email, phone), users!left(name)')
    .eq('id', id)
    .maybeSingle();
  if (jError) throw jError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });

  // Flatten nested data to match view expectations
  job.customer_name = job.customers?.name;
  job.customer_email = job.customers?.email;
  job.customer_phone = job.customers?.phone;
  job.assigned_name = job.users?.name;

  const { data: workOrders } = await supabase
    .from('work_orders')
    .select('id, display_number, wo_number_main, wo_number_sub, parent_wo_id, status, scheduled_date, created_at')
    .eq('job_id', id)
    .order('wo_number_main', { ascending: true })
    .order('wo_number_sub', { ascending: true });

  res.render('jobs/show', {
    title: job.title, activeNav: 'jobs',
    job, workOrders: workOrders || []
  });
});

router.get('/:id/edit', async (req, res) => {
  const id = req.params.id;
  const [{ data: job }, { data: customers }, { data: users }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', id).maybeSingle(),
    supabase.from('customers').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  res.render('jobs/edit', {
    title: `Edit ${job.title}`, activeNav: 'jobs',
    job, customers: customers || [], users: users || [], errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: job, error: findError } = await supabase.from('jobs').select('id, title').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  const { errors, data } = await validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/edit', {
      title: `Edit ${job.title}`, activeNav: 'jobs',
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
  setFlash(req, 'success', `Job "${data.title}" updated.`);
  res.redirect(`/jobs/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = req.params.id;
  const { data: job, error: findError } = await supabase.from('jobs').select('id, title').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Job not found.' });
  const { count: woCount } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('job_id', id);
  if (woCount) {
    setFlash(req, 'error', `Cannot delete "${job.title}" — it has ${woCount} work order(s).`);
    return res.redirect(`/jobs/${id}`);
  }
  const { error: deleteError } = await supabase.from('jobs').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', `Job "${job.title}" deleted.`);
  res.redirect('/jobs');
});

module.exports = router;
