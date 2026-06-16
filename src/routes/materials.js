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

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function toNumber(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function shortText(value, fallback = '', max = 160) {
  const text = String(value || fallback || '').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 3).trimEnd() + '...' : text;
}

function normalizeMaterialStatus(value) {
  const status = String(value || 'planned').toLowerCase();
  return ['planned', 'quoted', 'ordered', 'received', 'cancelled'].includes(status) ? status : 'planned';
}

function isMissingMaterialSyncSchema(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('scope_type') ||
    message.includes('rfp_line_item_id') ||
    message.includes('rfp_parent_line_item_id') ||
    message.includes('source') ||
    message.includes('schema cache');
}

async function syncRfpSupplierLinesToMaterials(jobId) {
  const numericJobId = parseInt(jobId, 10);

  const { data: rfps, error: rfpError } = await supabase
    .from('project_rfps')
    .select('id, contractor_name')
    .eq('job_id', numericJobId);
  if (rfpError) throw rfpError;

  const rfpIds = (rfps || []).map(rfp => rfp.id);
  if (!rfpIds.length) return;

  const { data: lines, error: lineError } = await supabase
    .from('rfp_line_items')
    .select('id, rfp_id, parent_line_item_id, vendor, description, quantity, contractor_cost, vendor_cost, unit_cost, total_cost, markup_pct, general_requirements_pct, approved, scope_type')
    .in('rfp_id', rfpIds);
  if (lineError) throw lineError;

  const lineById = new Map((lines || []).map(line => [String(line.id), line]));
  const rfpById = new Map((rfps || []).map(rfp => [String(rfp.id), rfp]));
  const supplierLines = (lines || []).filter(line =>
    line.parent_line_item_id &&
    line.scope_type === 'supplier' &&
    String(line.vendor || '').trim()
  );

  const [{ data: vendors, error: vendorError }, { data: categories, error: categoryError }] = await Promise.all([
    supabase.from('project_material_vendors').select('*').eq('job_id', numericJobId),
    supabase.from('project_material_categories').select('*').eq('job_id', numericJobId),
  ]);
  if (vendorError) throw vendorError;
  if (categoryError) throw categoryError;

  const vendorsByName = new Map((vendors || []).map(vendor => [normalizeKey(vendor.name), vendor]));
  const categoriesByVendorAndName = new Map((categories || []).map(category => [
    `${category.vendor_id || 'none'}:${normalizeKey(category.name)}`,
    category,
  ]));

  const categoryIds = (categories || []).map(category => category.id);
  let linkedItems = [];
  if (categoryIds.length) {
    const { data: items, error: itemsError } = await supabase
      .from('project_material_items')
      .select('*')
      .in('category_id', categoryIds);
    if (itemsError) throw itemsError;
    linkedItems = items || [];
  }

  const itemsByRfpLineId = new Map(
    linkedItems
      .filter(item => item.rfp_line_item_id)
      .map(item => [String(item.rfp_line_item_id), item])
  );
  const activeSupplierLineIds = new Set(supplierLines.map(line => String(line.id)));

  for (const item of linkedItems) {
    if (item.rfp_line_item_id && !activeSupplierLineIds.has(String(item.rfp_line_item_id))) {
      const { error: staleDeleteError } = await supabase
        .from('project_material_items')
        .delete()
        .eq('id', item.id);
      if (staleDeleteError) throw staleDeleteError;
    }
  }

  for (const supplierLine of supplierLines) {
    const vendorName = shortText(supplierLine.vendor, '', 180);
    if (!vendorName) continue;

    let materialVendor = vendorsByName.get(normalizeKey(vendorName));
    if (!materialVendor) {
      const { data: insertedVendor, error: insertVendorError } = await supabase
        .from('project_material_vendors')
        .insert({ job_id: numericJobId, name: vendorName })
        .select()
        .single();
      if (insertVendorError) throw insertVendorError;
      materialVendor = insertedVendor;
      vendorsByName.set(normalizeKey(vendorName), materialVendor);
    }

    const parentLine = lineById.get(String(supplierLine.parent_line_item_id));
    const rfp = rfpById.get(String(supplierLine.rfp_id));
    const categoryName = shortText(parentLine?.description, rfp?.contractor_name || 'RFP materials', 140) || 'RFP materials';
    const categoryKey = `${materialVendor.id}:${normalizeKey(categoryName)}`;

    let materialCategory = categoriesByVendorAndName.get(categoryKey);
    if (!materialCategory) {
      const { data: insertedCategory, error: insertCategoryError } = await supabase
        .from('project_material_categories')
        .insert({ job_id: numericJobId, vendor_id: materialVendor.id, name: categoryName })
        .select()
        .single();
      if (insertCategoryError) throw insertCategoryError;
      materialCategory = insertedCategory;
      categoriesByVendorAndName.set(categoryKey, materialCategory);
    }

    const quantity = toNumber(supplierLine.quantity, toNumber(parentLine?.quantity, 1)) || 1;
    const unitPrice = toNumber(supplierLine.contractor_cost, toNumber(supplierLine.unit_cost, 0));
    const itemName = shortText(supplierLine.description, parentLine?.description || vendorName, 250) || vendorName;
    const existingItem = itemsByRfpLineId.get(String(supplierLine.id));
    const sharedFields = {
      category_id: materialCategory.id,
      item_name: itemName,
      quantity,
      unit_price: unitPrice,
      vendor: vendorName,
      approved: !!supplierLine.approved,
      rfp_parent_line_item_id: supplierLine.parent_line_item_id,
    };

    if (existingItem) {
      const { error: updateError } = await supabase
        .from('project_material_items')
        .update(sharedFields)
        .eq('id', existingItem.id);
      if (updateError) throw updateError;
    } else {
      const { error: insertItemError } = await supabase
        .from('project_material_items')
        .insert({
          ...sharedFields,
          model_number: null,
          unit: null,
          notes: null,
          needed_by: null,
          status: 'planned',
          source: 'rfp',
          rfp_line_item_id: supplierLine.id,
        });
      if (insertItemError) throw insertItemError;
    }
  }
}

// ── Access middleware ──

async function resolveMaterialsJobId(req) {
  if (req.params.id) return req.params.id;
  if (!req.params.itemId) return null;

  const { data: item, error: itemError } = await supabase
    .from('project_material_items')
    .select('id, category_id')
    .eq('id', req.params.itemId)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item?.category_id) return null;

  const { data: category, error: categoryError } = await supabase
    .from('project_material_categories')
    .select('job_id')
    .eq('id', item.category_id)
    .maybeSingle();
  if (categoryError) throw categoryError;
  return category?.job_id || null;
}

async function requireMaterialsAccess(req, res, next) {
  const appRole = req.session?.role;
  try {
    if (appRole === 'admin') return next();
    const jobId = await resolveMaterialsJobId(req);
    if (!jobId) return denyProjectAccess(res, 'Project ID required.');
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

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('*, customers!inner(name)')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  try {
    await syncRfpSupplierLinesToMaterials(jobId);
  } catch (error) {
    if (isMissingMaterialSyncSchema(error)) {
      console.warn('RFP material sync skipped until migration is applied:', error.message || error);
    } else {
      throw error;
    }
  }

  const [{ data: vendors, error: vError }, { data: cats, error: cError }] = await Promise.all([
    supabase.from('project_material_vendors').select('*').eq('job_id', jobId).order('name', { ascending: true }),
    supabase.from('project_material_categories').select('*').eq('job_id', jobId).order('name', { ascending: true }),
  ]);
  if (vError) throw vError;
  if (cError) throw cError;

  const allCatIds = (cats || []).map(c => c.id);
  let itemsByCat = {};
  if (allCatIds.length) {
    const { data: items, error: iError } = await supabase
      .from('project_material_items')
      .select('*')
      .in('category_id', allCatIds)
      .order('created_at', { ascending: true });
    if (iError) throw iError;

    (items || []).forEach(it => {
      if (!itemsByCat[it.category_id]) itemsByCat[it.category_id] = [];
      itemsByCat[it.category_id].push(it);
    });
  }

  const catsByVendor = {};
  (cats || []).forEach(c => {
    c.items = itemsByCat[c.id] || [];
    const key = c.vendor_id || -1;
    if (!catsByVendor[key]) catsByVendor[key] = [];
    catsByVendor[key].push(c);
  });

  let vendorsList = vendors || [];
  if (catsByVendor[-1]?.length) {
    vendorsList = [{ id: -1, name: '(Unassigned)', job_id: parseInt(jobId, 10) }, ...vendorsList];
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
  const unit = (req.body.unit || '').trim();
  const status = normalizeMaterialStatus(req.body.status);
  const neededBy = (req.body.needed_by || '').trim();
  const notes = (req.body.notes || '').trim();
  const { data: item, error } = await supabase
    .from('project_material_items')
    .insert({
      category_id: parseInt(catId, 10),
      item_name: itemName,
      model_number: modelNumber || null,
      quantity,
      unit_price: unitPrice,
      unit: unit || null,
      status,
      needed_by: neededBy || null,
      notes: notes || null,
      source: 'manual',
    })
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
  const unit = (req.body.unit || '').trim();
  const status = normalizeMaterialStatus(req.body.status);
  const neededBy = (req.body.needed_by || '').trim();
  const notes = (req.body.notes || '').trim();
  const approved = req.body.approved === 'true' || req.body.approved === '1';
  const { error } = await supabase
    .from('project_material_items')
    .update({
      item_name: itemName,
      model_number: modelNumber || null,
      quantity,
      unit_price: unitPrice,
      unit: unit || null,
      status,
      needed_by: neededBy || null,
      notes: notes || null,
      approved,
    })
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
