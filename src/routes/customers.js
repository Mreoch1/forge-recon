/**
 * Customers CRUD (v0.5).
 *
 * Adds billing_email field. billing_email is used as recipient for invoices;
 * email (the "primary" contact) is used for estimates. Either falls back to
 * the other if blank.
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();
const PAGE_SIZE = 25;

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validateCustomer(body) {
  const errors = {};
  const name = emptyToNull(body.name);
  if (!name) errors.name = 'Name is required.';
  if (name && name.length > 200) errors.name = 'Name is too long (max 200).';

  const email = emptyToNull(body.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Email format looks invalid.';
  }
  const billing_email = emptyToNull(body.billing_email);
  if (billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billing_email)) {
    errors.billing_email = 'Billing email format looks invalid.';
  }

  return {
    errors,
    data: {
      name,
      email,
      billing_email,
      contact_name: emptyToNull(body.contact_name),
      phone: emptyToNull(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      notes: emptyToNull(body.notes),
    }
  };
}

function blankCustomer() {
  return {
    id: null, name: '', email: '', billing_email: '', phone: '',
    address: '', city: '', state: '', zip: '', notes: ''
  };
}

router.get('/', async (req, res) => {
  // F4: sanitize before interpolating into PostgREST .or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase.from('customers').select('id, name, email, billing_email, phone, city, state', { count: 'exact', head: false });
  let countQuery = supabase.from('customers').select('*', { count: 'exact', head: true });

  if (q) {
    const like = `%${q}%`;
    query = query.or(`name.ilike.${like},email.ilike.${like},billing_email.ilike.${like},phone.ilike.${like},city.ilike.${like}`);
    countQuery = countQuery.or(`name.ilike.${like},email.ilike.${like},billing_email.ilike.${like},phone.ilike.${like},city.ilike.${like}`);
  }

  const [{ data: customers, count: total }, { error }] = await Promise.all([
    query.order('name').range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (error) throw error;

  const totalPages = Math.max(1, Math.ceil((total || 0) / PAGE_SIZE));
  res.render('customers/index', {
    title: 'Customers', activeNav: 'customers',
    customers: customers || [], q, page, totalPages, total: total || 0
  });
});

router.get('/new', async (req, res) => {
  res.render('customers/new', {
    title: 'New customer', activeNav: 'customers',
    customer: blankCustomer(), errors: {}
  });
});

router.post('/', async (req, res) => {
  const { errors, data } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('customers/new', {
      title: 'New customer', activeNav: 'customers',
      customer: { id: null, ...data }, errors
    });
  }
  const { data: newCustomer, error: insertError } = await supabase
    .from('customers')
    .insert({
      name: data.name, email: data.email, billing_email: data.billing_email,
      phone: data.phone, address: data.address, city: data.city,
      state: data.state, zip: data.zip, notes: data.notes
    })
    .select()
    .single();
  if (insertError) throw insertError;
  // Auto-create root folder
  try {
    const filesSvc = require('../services/files');
    await filesSvc.ensureRootFolder('customer', newCustomer.id, req.session.userId).catch(e => console.warn('[files] ensureRootFolder:', e.message));
  } catch(e) { /* folder creation best effort */ }
  setFlash(req, 'success', `Customer "${data.name}" created.`);
  res.redirect(`/customers/${newCustomer.id}`);
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: customer, error: custError } = await supabase
    .from('customers').select('*').eq('id', id).maybeSingle();
  if (custError) throw custError;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });

  // D-071: paginated WO list with search + status filter
  const woPage = Math.max(1, parseInt(req.query.wo_page, 10) || 1);
  const woQ = sanitizePostgrestSearch((req.query.wo_q || '').trim());
  const woStatus = (req.query.wo_status || '').trim();
  const WO_PAGE_SIZE = 25;
  const woOffset = (woPage - 1) * WO_PAGE_SIZE;

  let woQuery = supabase
    .from('work_orders')
    .select('id, display_number, status, unit_number, description, scheduled_date, scheduled_time, created_at', { count: 'exact', head: false })
    .eq('customer_id', id);
  let woCountQuery = supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('customer_id', id);

  if (woStatus) {
    if (woStatus === 'open') {
      woQuery = woQuery.in('status', ['scheduled', 'in_progress', 'on_hold']);
      woCountQuery = woCountQuery.in('status', ['scheduled', 'in_progress', 'on_hold']);
    } else if (woStatus === 'closed') {
      woQuery = woQuery.in('status', ['complete', 'cancelled']);
      woCountQuery = woCountQuery.in('status', ['complete', 'cancelled']);
    } else {
      woQuery = woQuery.eq('status', woStatus);
      woCountQuery = woCountQuery.eq('status', woStatus);
    }
  }

  if (woQ) {
    const like = `%${woQ}%`;
    woQuery = woQuery.or(`display_number.ilike.${like},description.ilike.${like},unit_number.ilike.${like}`);
    woCountQuery = woCountQuery.or(`display_number.ilike.${like},description.ilike.${like},unit_number.ilike.${like}`);
  }

  const [{ data: workOrders, count: woTotal, error: woError }, { error: woCountError }, { count: fileCountCust, error: fileCountError }] = await Promise.all([
    woQuery.order('created_at', { ascending: false }).range(woOffset, woOffset + WO_PAGE_SIZE - 1),
    woCountQuery,
    supabase.from('files')
      .select('id', { count: 'exact', head: true })
      .eq('folder.entity_type', 'customer')
      .eq('folder.entity_id', id),
  ]);
  if (woError) throw woError;
  if (woCountError) throw woCountError;
  if (fileCountError) throw fileCountError;
  const fileCount = fileCountCust || 0;
  const woPages = Math.ceil((woTotal || 0) / WO_PAGE_SIZE);

  res.render('customers/show', {
    title: customer.name, activeNav: 'customers',
    customer, workOrders: workOrders || [], fileCount,
    woPage, woPages, woTotal, woQ, woStatus, WO_PAGE_SIZE,
  });
});

router.get('/:id/edit', async (req, res) => {
  const { data: customer, error } = await supabase.from('customers').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  res.render('customers/edit', {
    title: `Edit ${customer.name}`, activeNav: 'customers',
    customer, errors: {}
  });
});

router.post('/:id', async (req, res) => {
  const { data: customer, error: findError } = await supabase.from('customers').select('id, name').eq('id', req.params.id).maybeSingle();
  if (findError) throw findError;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  const { errors, data } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('customers/edit', {
      title: `Edit ${customer.name}`, activeNav: 'customers',
      customer: { id: customer.id, ...data }, errors
    });
  }
  const { error: updateError } = await supabase
    .from('customers')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (updateError) throw updateError;
  setFlash(req, 'success', `Customer "${data.name}" updated.`);
  res.redirect(`/customers/${req.params.id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = req.params.id;
  const { data: customer, error: findError } = await supabase.from('customers').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  const { count: workOrderCount, error: workOrderCountError } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('customer_id', id);
  if (workOrderCountError) throw workOrderCountError;
  if (workOrderCount > 0) {
    setFlash(req, 'error', `Cannot delete "${customer.name}" because they still have ${workOrderCount} work order(s).`);
    return res.redirect(`/customers/${id}`);
  }
  const { error: deleteError } = await supabase.from('customers').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', `Customer "${customer.name}" deleted.`);
  res.redirect('/customers');
});

module.exports = router;
