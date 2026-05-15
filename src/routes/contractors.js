/**
 * Contractors CRUD — for subcontracted workers (electrician, plumber, drywall sub, etc.).
 *
 * Parallel to vendors.js, but for trade-based subcontractors.
 *
 * Routes (requireManager gated in app.js):
 *   GET    /contractors              list with search + pagination
 *   GET    /contractors/new          new form
 *   POST   /contractors              create
 *   GET    /contractors/:id          detail (with WOs sub-table)
 *   GET    /contractors/:id/edit     edit form
 *   POST   /contractors/:id          update
 *   POST   /contractors/:id/delete   delete (rejected if WOs reference them)
 */

const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();
const PAGE_SIZE = 25;

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
  const trade = emptyToNull(body.trade);
  if (trade && !VALID_TRADES.includes(trade)) errors.trade = 'Invalid trade selected.';
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
      trade,
      license_number: emptyToNull(body.license_number),
      insurance_expiry_date: emptyToNull(body.insurance_expiry_date),
      notes: emptyToNull(body.notes),
    }
  };
}

router.get('/', async (req, res) => {
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase.from('contractors').select('id, name, email, phone, city, state, trade', { count: 'exact', head: false });
  let countQuery = supabase.from('contractors').select('*', { count: 'exact', head: true });

  if (q) {
    const like = `%${q}%`;
    query = query.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like},trade.ilike.${like}`);
    countQuery = countQuery.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like},trade.ilike.${like}`);
  }

  const [{ data: contractors, count: total }, { error }] = await Promise.all([
    query.order('name').range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (error) throw error;

  const totalPages = Math.max(1, Math.ceil((total || 0) / PAGE_SIZE));
  res.render('contractors/index', { title: 'Contractors', activeNav: 'contractors', contractors: contractors || [], q, page, totalPages, total: total || 0 });
});

router.get('/new', async (req, res) => {
  res.render('contractors/new', { title: 'New contractor', activeNav: 'contractors', contractor: {}, errors: {} });
});

router.post('/', async (req, res) => {
  const { errors, data } = validate(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('contractors/new', { title: 'New contractor', activeNav: 'contractors', contractor: { id: null, ...data }, errors });
  }
  const { data: newContractor, error: insertError } = await supabase
    .from('contractors')
    .insert({
      name: data.name, email: data.email, phone: data.phone,
      address: data.address, city: data.city, state: data.state,
      zip: data.zip, trade: data.trade,
      license_number: data.license_number,
      insurance_expiry_date: data.insurance_expiry_date,
      notes: data.notes,
    })
    .select()
    .single();
  if (insertError) throw insertError;
  // Auto-create root folder (mirrors vendors pattern).
  try {
    const filesSvc = require('../services/files');
    await filesSvc.ensureRootFolder('contractor', newContractor.id, req.session.userId)
      .catch(e => console.warn('[files] ensureRootFolder(contractor):', e.message));
  } catch (e) { /* folder creation best effort */ }
  setFlash(req, 'success', 'Contractor "' + data.name + '" created.');
  res.redirect('/contractors/' + newContractor.id);
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: contractor, error: cError } = await supabase.from('contractors').select('*').eq('id', id).maybeSingle();
  if (cError) throw cError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });

  // Check for work orders referencing this contractor
  const { data: workOrders, error: woError } = await supabase
    .from('work_orders')
    .select('id, display_number, status, created_at')
    .eq('contractor_id', id)
    .order('created_at', { ascending: false });
  if (woError) throw woError;

  // Contractor file workspace — fetch root folder + first-level contents.
  let rootFolder = null;
  let folders = [];
  let files = [];
  try {
    const filesSvc = require('../services/files');
    rootFolder = await filesSvc.getRootFolder('contractor', id);
    if (!rootFolder) {
      const newRootId = await filesSvc.ensureRootFolder('contractor', id, req.session.userId);
      if (newRootId) rootFolder = { id: newRootId, entity_type: 'contractor', entity_id: String(id) };
    }
    if (rootFolder) {
      const contents = await filesSvc.getFolderContents(rootFolder.id);
      folders = contents.subfolders || [];
      files = contents.files || [];
    }
  } catch (e) {
    throw new Error('[contractors:show] file workspace load failed: ' + e.message);
  }
  const fileCount = files.length;

  res.render('contractors/show', {
    title: contractor.name, activeNav: 'contractors',
    contractor, workOrders: workOrders || [], fileCount,
    rootFolder, folders, files
  });
});

router.get('/:id/edit', async (req, res) => {
  const id = req.params.id;
  const { data: contractor, error: cError } = await supabase.from('contractors').select('*').eq('id', id).maybeSingle();
  if (cError) throw cError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  res.render('contractors/edit', { title: 'Edit ' + contractor.name, activeNav: 'contractors', contractor, errors: {} });
});

router.post('/:id', async (req, res) => {
  const { errors, data } = validate(req.body);
  const id = req.params.id;
  const { data: contractor, error: findError } = await supabase.from('contractors').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  if (Object.keys(errors).length) {
    const contractor_merged = { id: contractor.id, ...data };
    return res.status(400).render('contractors/edit', { title: 'Edit ' + (data.name || contractor.name), activeNav: 'contractors', contractor: contractor_merged, errors });
  }
  const { error: updateError } = await supabase
    .from('contractors')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateError) throw updateError;
  setFlash(req, 'success', 'Contractor "' + data.name + '" updated.');
  res.redirect('/contractors/' + id);
});

router.post('/:id/delete', async (req, res) => {
  const id = req.params.id;
  const { data: contractor, error: findError } = await supabase.from('contractors').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  const { count: woCount, error: woCountError } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('contractor_id', id);
  if (woCountError) throw woCountError;
  if (woCount > 0) {
    setFlash(req, 'error', 'Cannot delete "' + contractor.name + '" — they have ' + woCount + ' work order(s).');
    return res.redirect('/contractors/' + id);
  }
  const { error: deleteError } = await supabase.from('contractors').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', 'Contractor "' + contractor.name + '" deleted.');
  res.redirect('/contractors');
});

// POST /contractors/:id/init-files — initialize root folder for contractor file workspace
router.post('/:id/init-files', async (req, res) => {
  const id = req.params.id;
  const { data: contractor, error } = await supabase
    .from('contractors')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  try {
    const filesSvc = require('../services/files');
    const rootFolderId = await filesSvc.ensureRootFolder('contractor', id, req.session.userId);
    if (rootFolderId) {
      setFlash(req, 'success', 'File workspace initialized for ' + contractor.name + '.');
      res.redirect('/files/folders/' + rootFolderId);
    } else {
      setFlash(req, 'error', 'Could not initialize file workspace.');
      res.redirect('/contractors/' + id);
    }
  } catch (e) {
    setFlash(req, 'error', 'Error initializing file workspace: ' + e.message);
    res.redirect('/contractors/' + id);
  }
});

module.exports = router;
