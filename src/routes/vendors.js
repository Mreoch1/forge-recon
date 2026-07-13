
/**
 * Vendors CRUD — for bills/payables tracking.
 *
 * Routes (requireManager gated in server.js):
 *   GET    /vendors              list with search + pagination
 *   GET    /vendors/new          new form
 *   POST   /vendors              create
 *   GET    /vendors/:id          detail (with bills sub-table)
 *   GET    /vendors/:id/edit     edit form
 *   POST   /vendors/:id          update
 *   POST   /vendors/:id/delete   delete (rejected if bills exist)
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash, requireAdmin } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { emptyToNullFormattedPhone } = require('../services/phone');

const router = express.Router();
const PAGE_SIZE = 25;
const VALID_COMPANY_ROLES = ['vendor', 'contractor', 'both'];
const VALID_TRADES = ['drywall', 'plumbing', 'electrical', 'HVAC', 'general', 'other'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validate(body) {
  const errors = {};
  const name = emptyToNull(body.name);
  if (!name) errors.name = 'Name is required.';
  if (name && name.length > 200) errors.name = 'Name is too long (max 200).';
  const company_role = VALID_COMPANY_ROLES.includes(body.company_role) ? body.company_role : 'vendor';
  const trade = emptyToNull(body.trade);
  if (trade && !VALID_TRADES.includes(trade)) errors.trade = 'Invalid trade selected.';
  return {
    errors,
    data: {
      company_role,
      name,
      email: emptyToNull(body.email),
      phone: emptyToNullFormattedPhone(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      ein: emptyToNull(body.ein),
      default_expense_account_id: parseInt(body.default_expense_account_id, 10) || null,
      trade,
      license_number: emptyToNull(body.license_number),
      insurance_expiry_date: emptyToNull(body.insurance_expiry_date),
      notes: emptyToNull(body.notes),
    }
  };
}

async function findContractorByName(name) {
  if (!name) return null;
  const { data, error } = await supabase
    .from('contractors')
    .select('*')
    .eq('name', name)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function syncContractorRole(data, userId) {
  const contractor = await findContractorByName(data.name);
  const wantsContractor = data.company_role === 'contractor' || data.company_role === 'both';

  if (!wantsContractor) {
    if (contractor) {
      const { error } = await supabase.from('contractors').update({ active: false, updated_at: new Date().toISOString() }).eq('id', contractor.id);
      if (error) throw error;
    }
    return contractor;
  }

  const payload = {
    name: data.name,
    email: data.email,
    phone: data.phone,
    address: data.address,
    city: data.city,
    state: data.state,
    zip: data.zip,
    trade: data.trade,
    default_expense_account_id: data.default_expense_account_id,
    license_number: data.license_number,
    insurance_expiry_date: data.insurance_expiry_date,
    notes: data.notes,
    active: true,
    updated_at: new Date().toISOString(),
  };

  if (contractor) {
    const { error } = await supabase.from('contractors').update(payload).eq('id', contractor.id);
    if (error) throw error;
    return contractor;
  }

  const { data: newContractor, error } = await supabase
    .from('contractors')
    .insert({ ...payload, created_by_user_id: userId || null })
    .select()
    .single();
  if (error) throw error;
  try {
    const filesSvc = require('../services/files');
    await filesSvc.ensureRootFolder('contractor', newContractor.id, userId)
      .catch(e => console.warn('[files] ensureRootFolder(contractor):', e.message));
  } catch (e) {}
  return newContractor;
}

function vendorPayload(data) {
  return {
    name: data.name,
    email: data.email,
    phone: data.phone,
    address: data.address,
    city: data.city,
    state: data.state,
    zip: data.zip,
    ein: data.ein,
    default_expense_account_id: data.default_expense_account_id,
    notes: data.notes,
    archived: data.company_role === 'contractor',
  };
}

router.get('/', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(302, '/companies' + qs);

  // F4: sanitize before interpolating into PostgREST .or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase.from('vendors').select('id, name, email, phone, city, state', { count: 'exact', head: false });
  let countQuery = supabase.from('vendors').select('*', { count: 'exact', head: true });

  if (q) {
    const like = `%${q}%`;
    query = query.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
    countQuery = countQuery.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
  }

  const [{ data: vendors, count: total }, { error }] = await Promise.all([
    query.order('name').range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (error) throw error;

  const totalPages = Math.max(1, Math.ceil((total || 0) / PAGE_SIZE));
  res.render('vendors/index', { title: 'Vendors', activeNav: 'vendors', vendors: vendors || [], q, page, totalPages, total: total || 0 });
});

router.get('/new', async (req, res) => {
  const { data: accounts, error: accountsError } = await supabase.from('accounts').select('id, code, name').in('type', ['expense']).eq('active', 1).order('code');
  if (accountsError) throw accountsError;
  res.render('vendors/new', { title: 'New company', activeNav: 'companies', vendor: { company_role: 'vendor' }, relatedContractor: {}, errors: {}, accounts: accounts || [] });
});

router.post('/', async (req, res) => {
  const { errors, data } = validate(req.body);
  if (Object.keys(errors).length) {
    const { data: accounts, error: accountsError } = await supabase.from('accounts').select('id, code, name').in('type', ['expense']).eq('active', 1).order('code');
    if (accountsError) throw accountsError;
    return res.status(400).render('vendors/new', { title: 'New company', activeNav: 'companies', vendor: { id: null, ...data }, relatedContractor: data, errors, accounts: accounts || [] });
  }
  const { data: newVendor, error: insertError } = await supabase
    .from('vendors')
    .insert(vendorPayload(data))
    .select()
    .single();
  if (insertError) throw insertError;
  await syncContractorRole(data, req.session.userId);
  // D-035: Auto-create root folder (mirrors customers.js pattern).
  try {
    const filesSvc = require('../services/files');
    await filesSvc.ensureRootFolder('vendor', newVendor.id, req.session.userId)
      .catch(e => console.warn('[files] ensureRootFolder(vendor):', e.message));
  } catch (e) { /* folder creation best effort */ }
  setFlash(req, 'success', 'Vendor "' + data.name + '" created.');
  res.redirect('/vendors/' + newVendor.id);
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: vendor, error: vError } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle();
  if (vError) throw vError;
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  const { data: bills, error: billsError } = await supabase.from('bills').select('id, bill_number, status, created_at').eq('vendor_id', id).order('created_at', { ascending: false });
  if (billsError) throw billsError;

  // D-035: Vendor file workspace — fetch root folder + first-level contents.
  // P0 fix: if root folder doesn't exist (failed on create), create it now.
  let rootFolder = null;
  let folders = [];
  let files = [];
  try {
    const filesSvc = require('../services/files');
    rootFolder = await filesSvc.getRootFolder('vendor', id);
    if (!rootFolder) {
      const newRootId = await filesSvc.ensureRootFolder('vendor', id, req.session.userId);
      if (newRootId) rootFolder = { id: newRootId, entity_type: 'vendor', entity_id: String(id) };
    }
    if (rootFolder) {
      const contents = await filesSvc.getFolderContents(rootFolder.id);
      folders = contents.subfolders || [];
      files = contents.files || [];
    }
  } catch (e) {
    throw new Error('[vendors:show] file workspace load failed: ' + e.message);
  }
  const fileCount = files.length;

  res.render('vendors/show', {
    title: vendor.name, activeNav: 'vendors',
    vendor, bills: bills || [], fileCount,
    rootFolder, folders, files
  });
});

router.get('/:id/edit', async (req, res) => {
  const id = req.params.id;
  const { data: vendor, error: vError } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle();
  if (vError) throw vError;
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  const { data: accounts, error: accountsError } = await supabase.from('accounts').select('id, code, name').in('type', ['expense']).eq('active', 1).order('code');
  if (accountsError) throw accountsError;
  const relatedContractor = await findContractorByName(vendor.name);
  vendor.company_role = relatedContractor && relatedContractor.active !== false
    ? (vendor.archived ? 'contractor' : 'both')
    : 'vendor';
  res.render('vendors/edit', { title: 'Edit ' + vendor.name, activeNav: 'companies', vendor, relatedContractor, errors: {}, accounts: accounts || [] });
});

router.post('/:id', async (req, res) => {
  const { errors, data } = validate(req.body);
  const id = req.params.id;
  const { data: vendor, error: findError } = await supabase.from('vendors').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  if (Object.keys(errors).length) {
    const vendor_merged = { id: vendor.id, ...data };
    const { data: accounts, error: accountsError } = await supabase.from('accounts').select('id, code, name').in('type', ['expense']).eq('active', 1).order('code');
    if (accountsError) throw accountsError;
    return res.status(400).render('vendors/edit', { title: 'Edit ' + (data.name || vendor.name), activeNav: 'companies', vendor: vendor_merged, relatedContractor: data, errors, accounts: accounts || [] });
  }
  const { error: updateError } = await supabase
    .from('vendors')
    .update({ ...vendorPayload(data), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateError) throw updateError;
  await syncContractorRole(data, req.session.userId);
  setFlash(req, 'success', 'Company "' + data.name + '" updated.');
  res.redirect('/companies');
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { data: vendor, error: findError } = await supabase.from('vendors').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  const { count: billCount, error: billCountError } = await supabase.from('bills').select('*', { count: 'exact', head: true }).eq('vendor_id', id);
  if (billCountError) throw billCountError;
  if (billCount > 0) {
    setFlash(req, 'error', 'Cannot delete "' + vendor.name + '" — they have ' + billCount + ' bill(s).');
    return res.redirect('/vendors/' + id);
  }
  const { error: deleteError } = await supabase.from('vendors').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', 'Vendor "' + vendor.name + '" deleted.');
  res.redirect('/vendors');
});

// POST /vendors/:id/init-files — initialize root folder for vendor file workspace
router.post('/:id/init-files', async (req, res) => {
  const id = req.params.id;
  const { data: vendor, error } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!vendor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Vendor not found.' });
  try {
    const filesSvc = require('../services/files');
    const rootFolderId = await filesSvc.ensureRootFolder('vendor', id, req.session.userId);
    if (rootFolderId) {
      setFlash(req, 'success', 'File workspace initialized for ' + vendor.name + '.');
      res.redirect('/files/folders/' + rootFolderId);
    } else {
      setFlash(req, 'error', 'Could not initialize file workspace.');
      res.redirect('/vendors/' + id);
    }
  } catch (e) {
    setFlash(req, 'error', 'Error initializing file workspace: ' + e.message);
    res.redirect('/vendors/' + id);
  }
});

module.exports = router;
