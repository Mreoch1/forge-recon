/**
 * Project Materials — track and order materials per project.
 *
 * Hierarchy: Vendor > Category > Items
 * Routes under /projects/:id/materials, mounted at app root.
 */

const express = require('express');
const supabase = require('../db/supabase');
const { loadProjectAccess, denyProjectAccess } = require('./jobs');

const router = express.Router();

// ── Access middleware ──

async function requireMaterialsAccess(req, res, next) {
  const appRole = req.session?.role;
  if (appRole === 'admin' || appRole === 'manager') return next();
  const jobId = req.params.id;
  if (!jobId) return denyProjectAccess(res, 'Project ID required.');
  try {
    const { data: job } = await supabase.from('jobs').select('id, project_manager_user_id, assigned_to_user_id').eq('id', jobId).maybeSingle();
    if (!job) return denyProjectAccess(res, 'Project not found.');
    const access = await loadProjectAccess(req, job);
    if (access.canSeeOperations) return next();
    denyProjectAccess(res, 'You do not have access to materials for this project.');
  } catch (e) {
    denyProjectAccess(res, 'Could not verify project access.');
  }
}

// ── GET /projects/:id/materials — materials page ──

router.get('/projects/:id/materials', requireMaterialsAccess, async (req, res) => {
  const jobId = req.params.id;

  const [{ data: job, error: jobError }, { data: vendors, error: vError }] = await Promise.all([
    supabase.from('jobs').select('*, customers!inner(name)').eq('id', jobId).maybeSingle(),
    supabase.from('project_material_vendors').select('*').eq('job_id', jobId).order('name', { ascending: true }),
  ]);

  if (jobError) throw jobError;
  if (vError) throw vError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  // Load categories per vendor
  let catsByVendor = {};

  // Also load categories with no vendor (pre-vendor migration) as "Unassigned"
  const { data: orphanCats, error: ocError } = await supabase
    .from('project_material_categories')
    .select('*')
    .eq('job_id', jobId)
    .is('vendor_id', null)
    .order('name', { ascending: true });
  if (ocError) throw ocError;

  let vendorsList = vendors || [];
  if (orphanCats && orphanCats.length) {
    vendorsList = [{ id: -1, name: '(Unassigned)', job_id: parseInt(jobId, 10) }, ...vendorsList];
    catsByVendor[-1] = orphanCats;
  }

  if (vendorsList.length) {
    const vIds = vendorsList.map(v => v.id);
    const { data: cats, error: cError } = await supabase
      .from('project_material_categories')
      .select('*')
      .or(`vendor_id.in.(${vIds.filter(id => id > 0).join(',')}),vendor_id.is.null`)
      .order('name', { ascending: true });
    if (cError) throw cError;

    (cats || []).forEach(c => {
      if (!catsByVendor[c.vendor_id]) catsByVendor[c.vendor_id] = [];
      catsByVendor[c.vendor_id].push(c);
    });

    // Load items for all categories
    const allCatIds = (cats || []).map(c => c.id);
    if (allCatIds.length) {
      const { data: items, error: iError } = await supabase
        .from('project_material_items')
        .select('*')
        .in('category_id', allCatIds)
        .order('created_at', { ascending: true });
      if (iError) throw iError;

      const itemsByCat = {};
      (items || []).forEach(it => {
        if (!itemsByCat[it.category_id]) itemsByCat[it.category_id] = [];
        itemsByCat[it.category_id].push(it);
      });

      // Attach items to categories
      (cats || []).forEach(c => { c.items = itemsByCat[c.id] || []; });
    }
  }

  res.render('jobs/materials', {
    title: 'Materials — ' + (job.title || job.name),
    activeNav: 'projects',
    job,
    vendors: vendorsList,
    catsByVendor,
  });
});

// ── Vendor CRUD ──

router.post('/projects/:id/materials/vendors', requireMaterialsAccess, async (req, res) => {
  const jobId = req.params.id;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' });
  const { data: vendor, error } = await supabase
    .from('project_material_vendors')
    .insert({ job_id: parseInt(jobId, 10), name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, vendor });
});

router.post('/projects/:id/materials/vendors/:vId/rename', requireMaterialsAccess, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const { error } = await supabase.from('project_material_vendors').update({ name }).eq('id', req.params.vId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/projects/:id/materials/vendors/:vId/delete', requireMaterialsAccess, async (req, res) => {
  const { error } = await supabase.from('project_material_vendors').delete().eq('id', req.params.vId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Category CRUD (under a vendor) ──

router.post('/projects/:id/materials/vendors/:vId/categories', requireMaterialsAccess, async (req, res) => {
  const { id: jobId } = req.params;
  const vId = req.params.vId;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  const { data: cat, error } = await supabase
    .from('project_material_categories')
    .insert({ job_id: parseInt(jobId, 10), vendor_id: parseInt(vId, 10), name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, category: cat });
});

router.post('/projects/:id/materials/categories/:catId/rename', requireMaterialsAccess, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const { error } = await supabase.from('project_material_categories').update({ name }).eq('id', req.params.catId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/projects/:id/materials/categories/:catId/delete', requireMaterialsAccess, async (req, res) => {
  const { error } = await supabase.from('project_material_categories').delete().eq('id', req.params.catId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Item CRUD (under a category) ──

router.post('/projects/:id/materials/categories/:catId/items', requireMaterialsAccess, async (req, res) => {
  const catId = req.params.catId;
  const itemName = (req.body.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'Item name is required.' });
  const modelNumber = (req.body.model_number || '').trim();
  const quantity = parseFloat(req.body.quantity) || 1;
  const unitPrice = parseFloat(req.body.unit_price) || 0;
  const { data: item, error } = await supabase
    .from('project_material_items')
    .insert({ category_id: parseInt(catId, 10), item_name: itemName, model_number: modelNumber || null, quantity, unit_price: unitPrice })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, item });
});

router.post('/projects/materials/items/:itemId', requireMaterialsAccess, async (req, res) => {
  const itemId = req.params.itemId;
  const itemName = (req.body.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'Item name is required.' });
  const modelNumber = (req.body.model_number || '').trim();
  const quantity = parseFloat(req.body.quantity) || 1;
  const unitPrice = parseFloat(req.body.unit_price) || 0;
  const approved = req.body.approved === 'true' || req.body.approved === '1';
  const { error } = await supabase
    .from('project_material_items')
    .update({ item_name: itemName, model_number: modelNumber || null, quantity, unit_price: unitPrice, approved })
    .eq('id', itemId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/projects/:id/materials/items/:itemId/approve', requireMaterialsAccess, async (req, res) => {
  const approved = req.body.approved === 'true' || req.body.approved === '1';
  const { error } = await supabase.from('project_material_items').update({ approved }).eq('id', req.params.itemId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/projects/:id/materials/items/:itemId/delete', requireMaterialsAccess, async (req, res) => {
  const { error } = await supabase.from('project_material_items').delete().eq('id', req.params.itemId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
