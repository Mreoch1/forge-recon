
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
const { setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();
const PAGE_SIZE = 25;

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
  return {
    errors,
    data: {
      name,
      email: emptyToNull(body.email),
      phone: emptyToNull(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      ein: emptyToNull(body.ein),
      default_expense_account_id: parseInt(body.default_expense_account_id, 10) || null,
      notes: emptyToNull(body.notes),
    }
  };
}

router.get('/', async (req, res) => {
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
  res.render('vendors/new', { title: 'New vendor', activeNav: 'vendors', vendor: {}, errors: {}, accounts: accounts || [] });
});

router.post('/', async (req, res) => {
  const { errors, data } = validate(req.body);
  if (Object.keys(errors).length) {
    const { data: accounts, error: accountsError } = await supabase.from('accounts').select('id, code, name').in('type', ['expense']).eq('active', 1).order('code');
    if (accountsError) throw accountsError;
    return res.status(400).render('vendors/new', { title: 'New vendor', activeNav: 'vendors', vendor: { id: null, ...data }, errors, accounts: accounts || [] });
  }
  const { data: newVendor, error: insertError } = await supabase
    .from('vendors')
    .insert({
      name: data.name, email: data.email, phone: data.phone,
      address: data.address, city: data.city, state: data.state,
      zip: data.zip, ein: data.ein, default_expense_account_id: data.default_expense_account_id, notes: data.notes
    })
    .select()
    .single();
  if (insertError) throw insertError;
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
  res.render('vendors/edit', { title: 'Edit ' + vendor.name, activeNav: 'vendors', vendor, errors: {}, accounts: accounts || [] });
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
    return res.status(400).render('vendors/edit', { title: 'Edit ' + (data.name || vendor.name), activeNav: 'vendors', vendor: vendor_merged, errors, accounts: accounts || [] });
  }
  const { error: updateError } = await supabase
    .from('vendors')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateError) throw updateError;
  setFlash(req, 'success', 'Vendor "' + data.name + '" updated.');
  res.redirect('/vendors/' + id);
});

router.post('/:id/delete', async (req, res) => {
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
