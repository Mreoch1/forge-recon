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
const { setFlash, requireAdmin } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { emptyToNullFormattedPhone } = require('../services/phone');

const router = express.Router();
const PAGE_SIZE = 25;

const VALID_TRADES = ['drywall', 'plumbing', 'electrical', 'HVAC', 'general', 'other'];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

async function loadExpenseAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, code, name')
    .eq('type', 'expense')
    .eq('active', true)
    .order('code', { ascending: true });
  if (error) throw error;
  return data || [];
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
      phone: emptyToNullFormattedPhone(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      trade,
      default_expense_account_id: parseInt(body.default_expense_account_id, 10) || null,
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

  const [{ data: contractors, count: total, error: listError }, { error: countError }] = await Promise.all([
    query.order('name').range(offset, offset + PAGE_SIZE - 1),
    countQuery,
  ]);
  if (listError) throw listError;
  if (countError) throw countError;

  const totalPages = Math.max(1, Math.ceil((total || 0) / PAGE_SIZE));
  res.render('contractors/index', { title: 'Contractors', activeNav: 'contractors', contractors: contractors || [], q, page, totalPages, total: total || 0 });
});

router.get('/new', async (req, res) => {
  const accounts = await loadExpenseAccounts();
  res.render('contractors/new', { title: 'New contractor', activeNav: 'contractors', contractor: {}, errors: {}, accounts });
});

router.post('/', async (req, res) => {
  const { errors, data } = validate(req.body);
  if (Object.keys(errors).length) {
    const accounts = await loadExpenseAccounts();
    return res.status(400).render('contractors/new', { title: 'New contractor', activeNav: 'contractors', contractor: { id: null, ...data }, errors, accounts });
  }
  const { data: newContractor, error: insertError } = await supabase
    .from('contractors')
    .insert({
      name: data.name, email: data.email, phone: data.phone,
      address: data.address, city: data.city, state: data.state,
      zip: data.zip, trade: data.trade,
      default_expense_account_id: data.default_expense_account_id,
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

  // ── Load scope projects — projects this contractor appears on in RFP line items ──
  let scopeProjects = [];
  try {
    const { data: scopeItems, error: scopeError } = await supabase
      .from('rfp_line_items')
      .select(`
        id, description, quantity, total_with_markup, approved,
        project_rfps!inner(job_id, jobs!inner(id, title, address, city, state, zip))
      `)
      .eq('vendor', contractor.name)
      .not('parent_line_item_id', 'is', null)
      .limit(500);
    if (!scopeError && scopeItems) {
      // Deduplicate by project
      const projMap = {};
      scopeItems.forEach(item => {
        const job = item.project_rfps?.jobs;
        if (job && !projMap[job.id]) {
          projMap[job.id] = { id: job.id, title: job.title, address: job.address, city: job.city, state: job.state, zip: job.zip, itemCount: 0 };
        }
        if (job) projMap[job.id].itemCount++;
      });
      scopeProjects = Object.values(projMap).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
  } catch (e) {
    console.warn('[contractors:show] scope load failed:', e.message);
  }

  let projectDocuments = [];
  try {
    const { data: docs, error: docsError } = await supabase
      .from('generated_documents')
      .select('id,title,status,project_id,scope_name,sent_at,signed_at,completed_at,created_at')
      .eq('contractor_id', id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (docsError) throw docsError;

    const projectIds = [...new Set((docs || []).map(d => d.project_id).filter(Boolean))];
    const projectsById = {};
    if (projectIds.length) {
      const { data: projects, error: projectsError } = await supabase
        .from('jobs')
        .select('id,title,address,city,state')
        .in('id', projectIds);
      if (projectsError) throw projectsError;
      (projects || []).forEach(project => { projectsById[project.id] = project; });
    }

    const grouped = new Map();
    (docs || []).forEach((doc) => {
      const key = doc.project_id || 'none';
      if (!grouped.has(key)) {
        grouped.set(key, { project: projectsById[doc.project_id] || null, documents: [] });
      }
      grouped.get(key).documents.push(doc);
    });
    projectDocuments = Array.from(grouped.values());
  } catch (e) {
    console.warn('[contractors:show] documents load failed:', e.message);
  }

  res.render('contractors/show', {
    title: contractor.name, activeNav: 'contractors',
    contractor, fileCount,
    rootFolder, folders, files,
    scopeProjects,
    projectDocuments,
  });
});

router.get('/:id/handoff/:projectId.pdf', async (req, res) => {
  const id = req.params.id;
  const projectId = req.params.projectId;

  const [{ data: contractor, error: cError }, { data: job, error: jError }] = await Promise.all([
    supabase.from('contractors').select('*').eq('id', id).maybeSingle(),
    supabase.from('jobs').select('*').eq('id', projectId).maybeSingle(),
  ]);
  if (cError) throw cError;
  if (jError) throw jError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  // Load RFP line items for this contractor on this project
  const { data: items, error: itemsError } = await supabase
    .from('rfp_line_items')
    .select(`
      id, description, quantity, unit_cost, total_cost, vendor, sort_order,
      project_rfps!inner(job_id)
    `)
    .eq('vendor', contractor.name)
    .eq('project_rfps.job_id', projectId)
    .not('parent_line_item_id', 'is', null)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (itemsError) throw itemsError;

  const { renderContractorHandoffPdf } = require('../services/rfp-export');
  const pdfBuffer = await renderContractorHandoffPdf(contractor, job, items || []);

  const safeName = (contractor.name || 'contractor').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const projName = (job.title || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="scope-${projName}-${safeName}.pdf"`);
  res.send(pdfBuffer);
});

router.get('/:id/edit', async (req, res) => {
  const id = req.params.id;
  const { data: contractor, error: cError } = await supabase.from('contractors').select('*').eq('id', id).maybeSingle();
  if (cError) throw cError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  const accounts = await loadExpenseAccounts();
  res.render('contractors/edit', { title: 'Edit ' + contractor.name, activeNav: 'contractors', contractor, errors: {}, accounts });
});

router.post('/:id', async (req, res) => {
  const { errors, data } = validate(req.body);
  const id = req.params.id;
  const { data: contractor, error: findError } = await supabase.from('contractors').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
  if (Object.keys(errors).length) {
    const contractor_merged = { id: contractor.id, ...data };
    const accounts = await loadExpenseAccounts();
    return res.status(400).render('contractors/edit', { title: 'Edit ' + (data.name || contractor.name), activeNav: 'contractors', contractor: contractor_merged, errors, accounts });
  }
  const { error: updateError } = await supabase
    .from('contractors')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateError) throw updateError;
  setFlash(req, 'success', 'Contractor "' + data.name + '" updated.');
  res.redirect('/contractors/' + id);
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { data: contractor, error: findError } = await supabase.from('contractors').select('id, name').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!contractor) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contractor not found.' });
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
