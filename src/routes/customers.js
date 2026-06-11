/**
 * Customers CRUD (v0.5).
 *
 * Adds billing_email field. billing_email is used as recipient for invoices;
 * email (the "primary" contact) is used for estimates. Either falls back to
 * the other if blank.
 */

const express = require('express');
const multer = require('multer');
const supabase = require('../db/supabase');
const { requireAdmin, setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { emptyToNullFormattedPhone } = require('../services/phone');

const router = express.Router();
const PAGE_SIZE = 25;
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (ch !== '\r') {
      value += ch;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function rowValue(row, headers, name) {
  const idx = headers.indexOf(normalizeHeader(name));
  return idx >= 0 ? emptyToNull(row[idx]) : null;
}

function buildAddress(address1, address2) {
  return [address1, address2].filter(Boolean).join('\n') || null;
}

function buildImportNotes(row, headers) {
  const notes = [];
  const baseNotes = rowValue(row, headers, 'Notes');
  const constructionNotes = rowValue(row, headers, '_Construction/Material_Related_Notes_445706');
  const customerType = rowValue(row, headers, 'CustomerType');
  const tax = rowValue(row, headers, 'Tax');
  const taxRate = rowValue(row, headers, 'TaxRate');
  const creationDate = rowValue(row, headers, 'CreationDate');
  const lastTicket = rowValue(row, headers, 'LastTicketAdded');
  const sourceId = rowValue(row, headers, 'ID');

  if (baseNotes) notes.push(baseNotes);
  if (constructionNotes) notes.push(`Construction/material notes: ${constructionNotes}`);
  if (customerType) notes.push(`mHelpDesk customer type: ${customerType}`);
  if (tax || taxRate) notes.push(`mHelpDesk tax: ${tax || '-'}${taxRate ? ` (${taxRate})` : ''}`);
  if (creationDate) notes.push(`mHelpDesk created: ${creationDate}`);
  if (lastTicket) notes.push(`mHelpDesk last ticket: ${lastTicket}`);
  if (sourceId) notes.push(`mHelpDesk ID: ${sourceId}`);
  return notes.join('\n') || null;
}

function parseMhelpdeskCustomersCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text).filter(row => row.some(cell => String(cell || '').trim()));
  if (rows.length < 2) {
    return { customers: [], errors: ['CSV did not contain any customer rows.'] };
  }
  const headers = rows[0].map(normalizeHeader);
  const required = ['id', 'name'];
  const missing = required.filter(h => !headers.includes(h));
  if (missing.length) {
    return { customers: [], errors: [`CSV is missing required column(s): ${missing.join(', ')}.`] };
  }

  const customers = [];
  const errors = [];
  rows.slice(1).forEach((row, idx) => {
    const line = idx + 2;
    const name = rowValue(row, headers, 'Name');
    if (!name || name === '[None]') return;
    if (name.length > 200) {
      errors.push(`Row ${line}: customer name is too long.`);
      return;
    }
    const email = rowValue(row, headers, 'email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`Row ${line}: skipped invalid email "${email}".`);
    }
    const address1 = rowValue(row, headers, 'address1');
    const address2 = rowValue(row, headers, 'address2');
    customers.push({
      mhelpdesk_customer_id: rowValue(row, headers, 'ID'),
      name,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      billing_email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      phone: emptyToNullFormattedPhone(rowValue(row, headers, 'primaryPhone')),
      address: buildAddress(address1, address2),
      city: rowValue(row, headers, 'city'),
      state: rowValue(row, headers, 'state'),
      zip: rowValue(row, headers, 'zip'),
      notes: buildImportNotes(row, headers),
    });
  });
  return { customers, errors };
}

function customerMatchKey(customer) {
  return [
    customer.name,
    customer.address,
    customer.city,
    customer.state,
    customer.zip,
  ].map(v => String(v || '').trim().toLowerCase()).join('|');
}

async function loadAllCustomersForImport() {
  const customers = [];
  let from = 0;
  const step = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, address, city, state, zip, mhelpdesk_customer_id')
      .order('id', { ascending: true })
      .range(from, from + step - 1);
    if (error) throw error;
    customers.push(...(data || []));
    if (!data || data.length < step) break;
    from += step;
  }
  return customers;
}

async function loadAccountOptions(type) {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, code, name')
    .eq('type', type)
    .eq('active', true)
    .order('code', { ascending: true });
  if (error) throw error;
  return data || [];
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
      phone: emptyToNullFormattedPhone(body.phone),
      default_income_account_id: parseInt(body.default_income_account_id, 10) || null,
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
    default_income_account_id: '', address: '', city: '', state: '', zip: '', notes: ''
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
  const accounts = await loadAccountOptions('revenue');
  res.render('customers/new', {
    title: 'New customer', activeNav: 'customers',
    customer: blankCustomer(), errors: {}, accounts
  });
});

router.post('/', async (req, res) => {
  const { errors, data } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    const accounts = await loadAccountOptions('revenue');
    return res.status(400).render('customers/new', {
      title: 'New customer', activeNav: 'customers',
      customer: { id: null, ...data }, errors, accounts
    });
  }
  const { data: newCustomer, error: insertError } = await supabase
    .from('customers')
    .insert({
      name: data.name, email: data.email, billing_email: data.billing_email,
      phone: data.phone, default_income_account_id: data.default_income_account_id,
      address: data.address, city: data.city,
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
  setFlash(req, 'success', `Customer "${data.name}" created. Next: <a href="/projects/new?customer_id=${newCustomer.id}" class="underline">create a project for this customer</a>.`);
  res.redirect(`/customers/${newCustomer.id}`);
});

router.get('/import', (req, res) => {
  res.render('customers/import', {
    title: 'Import customers', activeNav: 'customers',
    errors: [], result: null
  });
});

router.post('/import', importUpload.single('customers_csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).render('customers/import', {
      title: 'Import customers', activeNav: 'customers',
      errors: ['Choose the mHelpDesk customer CSV file before importing.'],
      result: null
    });
  }
  if (!/\.csv$/i.test(req.file.originalname || '')) {
    return res.status(400).render('customers/import', {
      title: 'Import customers', activeNav: 'customers',
      errors: ['Customer import only accepts .csv files.'],
      result: null
    });
  }

  const parsed = parseMhelpdeskCustomersCsv(req.file.buffer);
  if (!parsed.customers.length) {
    return res.status(400).render('customers/import', {
      title: 'Import customers', activeNav: 'customers',
      errors: parsed.errors.length ? parsed.errors : ['No importable customers were found in that CSV.'],
      result: null
    });
  }

  const existing = await loadAllCustomersForImport();
  const byMhelpId = new Map();
  const byNaturalKey = new Map();
  existing.forEach(customer => {
    if (customer.mhelpdesk_customer_id) byMhelpId.set(String(customer.mhelpdesk_customer_id), customer);
    byNaturalKey.set(customerMatchKey(customer), customer);
  });

  const stats = { imported: parsed.customers.length, created: 0, updated: 0, skipped: 0 };
  const seenMhelpIds = new Set();
  const seenNaturalKeys = new Set();
  const filesSvc = require('../services/files');

  for (const customer of parsed.customers) {
    const mhelpId = customer.mhelpdesk_customer_id ? String(customer.mhelpdesk_customer_id) : null;
    const naturalKey = customerMatchKey(customer);
    if ((mhelpId && seenMhelpIds.has(mhelpId)) || seenNaturalKeys.has(naturalKey)) {
      stats.skipped++;
      continue;
    }
    if (mhelpId) seenMhelpIds.add(mhelpId);
    seenNaturalKeys.add(naturalKey);

    const existingCustomer = (mhelpId && byMhelpId.get(mhelpId)) || byNaturalKey.get(naturalKey);
    const payload = {
      ...customer,
      updated_at: new Date().toISOString(),
    };

    if (existingCustomer) {
      const { error } = await supabase
        .from('customers')
        .update(payload)
        .eq('id', existingCustomer.id);
      if (error) throw error;
      stats.updated++;
      await filesSvc.ensureRootFolder('customer', existingCustomer.id, req.session.userId).catch(e => console.warn('[files] ensureRootFolder:', e.message));
    } else {
      const { data: inserted, error } = await supabase
        .from('customers')
        .insert(payload)
        .select('id')
        .single();
      if (error) throw error;
      stats.created++;
      await filesSvc.ensureRootFolder('customer', inserted.id, req.session.userId).catch(e => console.warn('[files] ensureRootFolder:', e.message));
    }
  }

  const warnings = parsed.errors.slice(0, 20);
  setFlash(req, 'success', `Customer import complete: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} duplicate row(s) skipped.`);
  res.render('customers/import', {
    title: 'Import customers', activeNav: 'customers',
    errors: warnings,
    result: { filename: req.file.originalname, ...stats, warningCount: parsed.errors.length }
  });
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
      woQuery = woQuery.in('status', ['open', 'scheduled', 'in_progress', 'on_hold']);
      woCountQuery = woCountQuery.in('status', ['open', 'scheduled', 'in_progress', 'on_hold']);
    } else if (woStatus === 'closed') {
      woQuery = woQuery.in('status', ['closed', 'complete', 'cancelled']);
      woCountQuery = woCountQuery.in('status', ['closed', 'complete', 'cancelled']);
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

  const [{ data: workOrders, count: woTotal, error: woError }, { error: woCountError }] = await Promise.all([
    woQuery.order('created_at', { ascending: false }).range(woOffset, woOffset + WO_PAGE_SIZE - 1),
    woCountQuery,
  ]);
  if (woError) throw woError;
  if (woCountError) throw woCountError;

  const { data: projects, error: projectsError } = await supabase
    .from('jobs')
    .select('id, title, status, address, city, state, created_at')
    .eq('customer_id', id)
    .order('created_at', { ascending: false });
  if (projectsError) throw projectsError;

  // D-072: Customer file workspace — fetch root folder + first-level contents
  // P0 fix: if root folder doesn't exist (failed on create), create it now.
  let rootFolder = null;
  let folders = [];
  let files = [];
  let fileCount = 0;
  try {
    const filesSvc = require('../services/files');
    rootFolder = await filesSvc.getRootFolder('customer', id);
    if (!rootFolder) {
      const newRootId = await filesSvc.ensureRootFolder('customer', id, req.session.userId);
      if (newRootId) rootFolder = { id: newRootId, entity_type: 'customer', entity_id: String(id) };
    }
    if (rootFolder) {
      const contents = await filesSvc.getFolderContents(rootFolder.id);
      folders = contents.subfolders || [];
      files = contents.files || [];
      fileCount = files.length;
    }
  } catch (e) {
    throw new Error('[customers:show] file workspace load failed: ' + e.message);
  }
  const woPages = Math.ceil((woTotal || 0) / WO_PAGE_SIZE);

  // F-013: Load projects (jobs) for this customer
  let customerProjects = [];
  try {
    const { data: projData } = await supabase
      .from('jobs')
      .select('id, title, address, city, state, status, created_at')
      .eq('customer_id', id)
      .order('created_at', { ascending: false });
    customerProjects = projData || [];
  } catch (e) {
    console.warn('[customers] projects load failed:', e.message);
  }

  res.render('customers/show', {
    title: customer.name, activeNav: 'customers',
    customer, workOrders: workOrders || [], fileCount,
    projects: projects || [],
    woPage, woPages, woTotal, woQ, woStatus, WO_PAGE_SIZE,
    rootFolder, folders, files,
    customerProjects
  });
});

router.get('/:id/edit', async (req, res) => {
  const { data: customer, error } = await supabase.from('customers').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  const accounts = await loadAccountOptions('revenue');
  res.render('customers/edit', {
    title: `Edit ${customer.name}`, activeNav: 'customers',
    customer, errors: {}, accounts
  });
});

router.post('/:id', async (req, res) => {
  const { data: customer, error: findError } = await supabase.from('customers').select('id, name').eq('id', req.params.id).maybeSingle();
  if (findError) throw findError;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  const { errors, data } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    const accounts = await loadAccountOptions('revenue');
    return res.status(400).render('customers/edit', {
      title: `Edit ${customer.name}`, activeNav: 'customers',
      customer: { id: customer.id, ...data }, errors, accounts
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

router.post('/:id/delete', requireAdmin, async (req, res) => {
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

// POST /customers/:id/init-files — initialize root folder for customer file workspace
router.post('/:id/init-files', async (req, res) => {
  const id = req.params.id;
  const { data: customer, error } = await supabase
    .from('customers')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!customer) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Customer not found.' });
  try {
    const filesSvc = require('../services/files');
    const rootFolderId = await filesSvc.ensureRootFolder('customer', id, req.session.userId);
    if (rootFolderId) {
      setFlash(req, 'success', 'File workspace initialized for ' + customer.name + '.');
      res.redirect('/files/folders/' + rootFolderId);
    } else {
      setFlash(req, 'error', 'Could not initialize file workspace.');
      res.redirect('/customers/' + id);
    }
  } catch (e) {
    setFlash(req, 'error', 'Error initializing file workspace: ' + e.message);
    res.redirect('/customers/' + id);
  }
});

module.exports = router;
