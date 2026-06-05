/**
 * Project Materials — track and order materials per project.
 *
 * Routes use URLs under /projects/:id/materials to match the RFP pattern.
 * Mount at the app root so /projects/:id/materials works alongside other
 * project routes.
 *
 * Simple two-level hierarchy: categories > items (no sub-items).
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

// ── GET /projects/:id/materials — materials management page ──

router.get('/projects/:id/materials', requireMaterialsAccess, async (req, res) => {
  const jobId = req.params.id;

  const [{ data: job, error: jobError }, { data: categories, error: catsError }] = await Promise.all([
    supabase.from('jobs').select('*, customers!inner(name)').eq('id', jobId).maybeSingle(),
    supabase.from('project_material_categories').select('*').eq('job_id', jobId).order('created_at', { ascending: false }),
  ]);

  if (jobError) throw jobError;
  if (catsError) throw catsError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  // Load items sorted by vendor then category
  let itemsByVendorCat = {};
  if (categories && categories.length) {
    const catIds = categories.map(c => c.id);
    const { data: allItems, error: itemsError } = await supabase
      .from('project_material_items')
      .select('*')
      .in('category_id', catIds)
      .order('vendor', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    if (itemsError) throw itemsError;

    // Build lookup: category_id -> category name
    const catMap = {};
    categories.forEach(c => { catMap[c.id] = c.name; });

    // Group by (vendor, category_id)
    (allItems || []).forEach(item => {
      const vKey = (item.vendor || '').trim() || '(Unassigned)';
      const cKey = item.category_id;
      if (!itemsByVendorCat[vKey]) itemsByVendorCat[vKey] = {};
      if (!itemsByVendorCat[vKey][cKey]) itemsByVendorCat[vKey][cKey] = { catName: catMap[cKey] || 'Unknown', items: [] };
      itemsByVendorCat[vKey][cKey].items.push(item);
    });
  }

  res.render('jobs/materials', {
    title: 'Materials — ' + (job.title || job.name),
    activeNav: 'projects',
    job,
    categories: categories || [],
    itemsByVendorCat,
  });
});

// ── POST /projects/:id/materials/categories — create a new material category ──

router.post('/projects/:id/materials/categories', requireMaterialsAccess, async (req, res) => {
  const jobId = req.params.id;
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Category name is required.' });
  }
  const { data: cat, error } = await supabase
    .from('project_material_categories')
    .insert({ job_id: parseInt(jobId, 10), name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, category: cat });
});

// ── POST /projects/:id/materials/categories/:catId/rename ──

router.post('/projects/:id/materials/categories/:catId/rename', requireMaterialsAccess, async (req, res) => {
  const catId = req.params.catId;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const { error } = await supabase.from('project_material_categories').update({ name }).eq('id', catId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /projects/:id/materials/categories/:catId/delete ──

router.post('/projects/:id/materials/categories/:catId/delete', requireMaterialsAccess, async (req, res) => {
  const catId = req.params.catId;
  const { error } = await supabase.from('project_material_categories').delete().eq('id', catId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /projects/:id/materials/categories/:catId/items — add a material item ──

router.post('/projects/:id/materials/categories/:catId/items', requireMaterialsAccess, async (req, res) => {
  const catId = req.params.catId;
  const itemName = (req.body.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'Item name is required.' });
  const modelNumber = (req.body.model_number || '').trim();
  const quantity = parseFloat(req.body.quantity) || 1;
  const unitPrice = parseFloat(req.body.unit_price) || 0;
  const vendor = (req.body.vendor || '').trim();
  const { data: item, error } = await supabase
    .from('project_material_items')
    .insert({ category_id: parseInt(catId, 10), item_name: itemName, model_number: modelNumber || null, quantity, unit_price: unitPrice, vendor: vendor || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, item });
});

// ── POST /projects/:id/materials/items/:itemId — update a material item ──

router.post('/projects/materials/items/:itemId', requireMaterialsAccess, async (req, res) => {
  const itemId = req.params.itemId;
  const itemName = (req.body.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'Item name is required.' });
  const modelNumber = (req.body.model_number || '').trim();
  const quantity = parseFloat(req.body.quantity) || 1;
  const unitPrice = parseFloat(req.body.unit_price) || 0;
  const vendor = (req.body.vendor || '').trim();
  const approved = req.body.approved === 'true' || req.body.approved === '1';
  const { error } = await supabase
    .from('project_material_items')
    .update({ item_name: itemName, model_number: modelNumber || null, quantity, unit_price: unitPrice, vendor: vendor || null, approved })
    .eq('id', itemId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /projects/:id/materials/items/:itemId/approve — toggle approval ──

router.post('/projects/:id/materials/items/:itemId/approve', requireMaterialsAccess, async (req, res) => {
  const itemId = req.params.itemId;
  const approved = req.body.approved === 'true' || req.body.approved === '1';
  const { error } = await supabase.from('project_material_items').update({ approved }).eq('id', itemId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /projects/:id/materials/items/:itemId/delete ──

router.post('/projects/:id/materials/items/:itemId/delete', requireMaterialsAccess, async (req, res) => {
  const itemId = req.params.itemId;
  const { error } = await supabase.from('project_material_items').delete().eq('id', itemId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
