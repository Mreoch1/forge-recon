/**
 * RFP / Bid routes — contractor bid comparison for Projects.
 * Matches the RFP Template.xlsx structure: contractors submit line items
 * with vendor, costs, markup %, and final unit cost calculations.
 *
 * Routes mounted at / under requireAuth.
 */
const express = require('express');
const supabase = require('../db/supabase');
const { requireAdmin, requireAuth } = require('../middleware/auth');
const { loadProjectAccess, denyProjectAccess } = require('./jobs');

const router = express.Router();

const FALLBACK_VENDOR_NAMES = [
  'Advanced Specialties',
  'Amistee',
  "Anderson & Son's Painting",
  'Architectural Hardware & Supply',
  'DWG Plumbing',
  'Eastbay',
  'Electric Doctor',
  'ES Repair Pros',
  'Ferguson',
  'Hardrock Stoneworks',
  'Home Depot',
  'Main Flooring',
  'Motor City Heating And Cooling',
  'RT Acoustical',
  'Runco',
  'Wholesale Builder Supply',
  'WillScot',
  "Benson's",
  'Demo Paint Supply Co.',
  'Demo Roofing Supply Inc.',
];

const FALLBACK_CONTRACTORS = [
  { name: "Anderson & Son's Painting", trade: 'drywall' },
  { name: 'DWG Plumbing', trade: 'plumbing' },
  { name: 'Electric Doctor', trade: 'electrical' },
  { name: 'ES Repair Pros', trade: 'general' },
  { name: 'Motor City Heating And Cooling', trade: 'HVAC' },
  { name: 'RT Acoustical', trade: 'general' },
  { name: 'Advanced Specialties', trade: 'general' },
  { name: 'Amistee', trade: 'general' },
  { name: 'Architectural Hardware & Supply', trade: 'general' },
  { name: 'Eastbay', trade: 'general' },
  { name: 'Ferguson', trade: 'general' },
  { name: 'Hardrock Stoneworks', trade: 'general' },
  { name: 'Home Depot', trade: 'general' },
  { name: 'Main Flooring', trade: 'general' },
  { name: 'Runco', trade: 'general' },
  { name: 'WillScot', trade: 'general' },
  { name: 'Wholesale Builder Supply', trade: 'general' },
  { name: "Benson's", trade: 'general' },
  { name: 'Demo Paint Supply Co.', trade: 'drywall' },
  { name: 'Demo Roofing Supply Inc.', trade: 'general' },
];

function fallbackVendors() {
  return FALLBACK_VENDOR_NAMES.map(name => ({ id: null, name }));
}

function normalizeAutocompleteSources(vendors, contractors) {
  return {
    vendors: vendors && vendors.length ? vendors : fallbackVendors(),
    contractors: contractors && contractors.length ? contractors : FALLBACK_CONTRACTORS,
  };
}

function isMissingOptionalRfpTable(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('project_rfps') ||
    message.includes('rfp_line_items') ||
    message.includes('does not exist') ||
    message.includes('schema cache')
  );
}

function rfpRedirect(jobId, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const qs = search.toString();
  return `/projects/${jobId}/rfp${qs ? `?${qs}` : ''}`;
}

async function deleteRfpLineItemTree(itemId, visited = new Set()) {
  const normalizedItemId = String(itemId);
  if (visited.has(normalizedItemId)) return;
  visited.add(normalizedItemId);

  const { data: children, error: childrenError } = await supabase
    .from('rfp_line_items')
    .select('id')
    .eq('parent_line_item_id', itemId);
  if (childrenError) throw childrenError;

  for (const child of children || []) {
    await deleteRfpLineItemTree(child.id, visited);
  }

  const { error } = await supabase
    .from('rfp_line_items')
    .delete()
    .eq('id', itemId);
  if (error) throw error;
}

// ── Project-level access middleware for RFP routes ──
// Allows access if user is app admin/manager, or has project-level
// operations access (superintendent, pre_construction, admin member role).
async function requireRfpAccess(req, res, next) {
  const appRole = req.session?.role;
  if (appRole === 'admin' || appRole === 'manager') return next();
  const jobId = req.params.id;
  if (!jobId) return denyProjectAccess(res, 'Project ID required.');
  try {
    const { data: job } = await supabase.from('jobs').select('id, project_manager_user_id, assigned_to_user_id').eq('id', jobId).maybeSingle();
    if (!job) return denyProjectAccess(res, 'Project not found.');
    const access = await loadProjectAccess(req, job);
    if (access.canSeeOperations) return next();
    denyProjectAccess(res, 'You do not have access to RFP data for this project.');
  } catch (e) {
    denyProjectAccess(res, 'Could not verify project access.');
  }
}

async function requireRfpEditAccess(req, res, next) {
  const appRole = req.session?.role;
  if (appRole === 'admin' || appRole === 'manager') return next();
  const jobId = req.params.id;
  // Some routes use /projects/rfps/items/:itemId — extract job_id from item when needed
  if (!jobId) return denyProjectAccess(res, 'Project ID required.');
  try {
    const { data: job } = await supabase.from('jobs').select('id, project_manager_user_id, assigned_to_user_id').eq('id', jobId).maybeSingle();
    if (!job) return denyProjectAccess(res, 'Project not found.');
    const access = await loadProjectAccess(req, job);
    if (access.canSeeOperations) return next();
    denyProjectAccess(res, 'You do not have permission to edit RFP data for this project.');
  } catch (e) {
    denyProjectAccess(res, 'Could not verify project access.');
  }
}

// ── GET /projects/:id/rfp — dedicated RFP management page for a project ──
router.get('/projects/:id/rfp', requireAuth, requireRfpAccess, async (req, res) => {
  const jobId = req.params.id;

  const [{ data: job, error: jobError }, { data: rfps, error: rfpsError }, { data: vendors, error: vendorsError }, { data: contractors, error: contractorsError }] = await Promise.all([
    supabase.from('jobs').select('*, customers!inner(name)').eq('id', jobId).maybeSingle(),
    supabase
      .from('project_rfps')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false }),
    supabase.from('vendors').select('id, name').order('name', { ascending: true }),
    supabase.from('contractors').select('id, name, trade').order('name', { ascending: true }),
  ]);

  if (jobError) throw jobError;
  if (rfpsError && !isMissingOptionalRfpTable(rfpsError)) throw rfpsError;
  if (vendorsError) console.warn('[rfp] vendor autocomplete source failed:', vendorsError.message);
  if (contractorsError) console.warn('[rfp] contractor autocomplete source failed:', contractorsError.message);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  // Load RFP line items for each RFP
  let rfpItemsMap = {};
  if (rfps && rfps.length) {
    try {
      const rfpIds = rfps.map(r => r.id);
      const { data: allItems, error: itemsError } = await supabase
        .from('rfp_line_items')
        .select('*')
        .in('rfp_id', rfpIds)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });
      if (itemsError) throw itemsError;
      (allItems || []).forEach(item => {
        (rfpItemsMap[item.rfp_id] = rfpItemsMap[item.rfp_id] || []).push(item);
      });
    } catch (e) {
      if (!isMissingOptionalRfpTable(e)) throw e;
    }
  }

  const sources = normalizeAutocompleteSources(vendorsError ? [] : vendors, contractorsError ? [] : contractors);

  res.render('jobs/rfp', {
    title: 'RFP — ' + (job.title || job.name),
    activeNav: 'projects',
    job,
    rfps: rfpsError ? [] : (rfps || []),
    rfpItemsMap,
    customers: job.customers || {},
    vendors: sources.vendors,
    contractors: sources.contractors,
  });
});

// ── GET /api/rfp-sources — JSON endpoint with vendors + contractors for autocomplete ──
router.get('/api/rfp-sources', requireAdmin, async (req, res) => {
  try {
    const [vr, cr] = await Promise.all([
      supabase.from('vendors').select('id, name').order('name'),
      supabase.from('contractors').select('id, name, trade').order('name'),
    ]);
    if (vr.error) console.warn('[rfp-sources] vendors fetch failed:', vr.error.message);
    if (cr.error) console.warn('[rfp-sources] contractors fetch failed:', cr.error.message);
    const sources = normalizeAutocompleteSources(vr.error ? [] : vr.data, cr.error ? [] : cr.data);
    res.json(sources);
  } catch (e) {
    console.warn('[rfp-sources] fetch failed:', e.message);
    res.json(normalizeAutocompleteSources([], []));
  }
});

// ── GET /projects/:id/rfps — list RFPs for a project (JSON endpoint) ──
router.get('/projects/:id/rfps', requireRfpEditAccess, async (req, res) => {
  const jobId = req.params.id;
  const { data: rfps, error } = await supabase
    .from('project_rfps')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(rfps || []);
});

// ── GET /projects/:id/rfps/:rId/items — line items for an RFP (JSON) ──
router.get('/projects/:id/rfps/:rId/items', requireRfpEditAccess, async (req, res) => {
  const { data: items, error } = await supabase
    .from('rfp_line_items')
    .select('*')
    .eq('rfp_id', req.params.rId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  res.json(items || []);
});

// ── POST /projects/:id/rfps — create a new RFP category ──
router.post('/projects/:id/rfps', requireRfpEditAccess, async (req, res) => {
  const { contractor_name, notes } = req.body;
  const { data, error } = await supabase
    .from('project_rfps')
    .insert({
      job_id: req.params.id,
      contractor_name: contractor_name || 'New Category',
      notes: notes || null,
      created_by_user_id: req.session.userId || req.user?.id || null,
    })
    .select()
    .single();
  if (error) throw error;
  res.redirect(rfpRedirect(req.params.id, { open_rfp: data?.id, show_category_form: 1 }));
});

// ── POST /projects/:id/rfps/:rId — update RFP status or rename category (D-101) ──
router.post('/projects/:id/rfps/:rId', requireRfpEditAccess, async (req, res) => {
  const { status, contractor_name } = req.body;
  const updateFields = { updated_at: new Date().toISOString() };
  const validStatuses = ['pending', 'submitted', 'awarded', 'declined'];
  if (status && validStatuses.includes(status)) {
    updateFields.status = status;
  }
  if (contractor_name && contractor_name.trim()) {
    updateFields.contractor_name = contractor_name.trim();
  }
  if (Object.keys(updateFields).length > 1) { // more than just updated_at
    const { error } = await supabase
      .from('project_rfps')
      .update(updateFields)
      .eq('id', req.params.rId)
      .eq('job_id', req.params.id);
    if (error) throw error;
  }
  res.redirect(rfpRedirect(req.params.id, { open_rfp: req.params.rId }));
});

// ── POST /projects/:id/rfps/:rId/items — add line item ──
router.post('/projects/:id/rfps/:rId/items', requireRfpEditAccess, async (req, res) => {
  const { vendor, description, quantity, contractor_cost, vendor_cost,
          unit_cost, total_cost, markup_pct, parent_id } = req.body;

  // D-132: reject creating a child of a child (sub-sub-line)
  if (parent_id) {
    const { data: parentItem } = await supabase
      .from('rfp_line_items')
      .select('parent_line_item_id')
      .eq('id', parent_id)
      .maybeSingle();
    if (parentItem && parentItem.parent_line_item_id) {
      return res.status(400).render('error', {
        title: 'Bad request', code: 400,
        message: 'Cannot create a sub-line under another sub-line. Only two levels are supported: Line item → Sub-line.'
      });
    }
  }

  const markup = parseFloat(markup_pct) || 20;
  const cCost = parseFloat(contractor_cost) || 0;
  const vCost = parseFloat(vendor_cost) || 0;
  const uCost = parseFloat(unit_cost) || 0;
  const tCost = parseFloat(total_cost) || 0;
  const qty = parseFloat(quantity) || 0;
  // D-140: GR was hardcoded at 6% on insert; now read from request, default 6.
  const gr = parseFloat(req.body.general_requirements_pct);
  const grPct = isFinite(gr) ? gr : 6;

  // D-140: Markup and GR are ADDITIVE percentages applied once — not compounding.
  //   total_with_markup = total_cost × (1 + (markup% + gr%) / 100)
  const baseCost = tCost || (uCost * qty) || (cCost + vCost);
  const withMarkup = baseCost * (1 + (markup + grPct) / 100);

  const { data, error } = await supabase
    .from('rfp_line_items')
    .insert({
      rfp_id: req.params.rId,
      parent_line_item_id: parent_id || null,
      vendor: vendor || null,
      description: description || '',
      quantity: qty || null,
      contractor_cost: cCost || null,
      vendor_cost: vCost || null,
      unit_cost: uCost || null,
      total_cost: baseCost || null,
      markup_pct: markup,
      general_requirements_pct: grPct,
      total_with_markup: withMarkup,
      final_unit_cost: baseCost > 0 ? withMarkup / (qty || 1) : 0,
    })
    .select()
    .single();
  if (error) throw error;
  res.redirect(rfpRedirect(req.params.id, {
    open_rfp: req.params.rId,
    open_item: parent_id || data?.id,
    show_sub_form: parent_id || '',
  }));
});

// ── POST /projects/:id/rfps/:rId/delete — remove an RFP (POST + suffix path because
//    method-override middleware isn't installed; ?_method=DELETE doesn't work) ──
router.post('/projects/:id/rfps/:rId/delete', requireRfpEditAccess, async (req, res) => {
  const { error: itemsError } = await supabase.from('rfp_line_items').delete().eq('rfp_id', req.params.rId);
  if (itemsError) throw itemsError;
  const { error: rfpError } = await supabase.from('project_rfps').delete().eq('id', req.params.rId).eq('job_id', req.params.id);
  if (rfpError) throw rfpError;
  res.redirect(`/projects/${req.params.id}/rfp`);
});

// ── POST /projects/rfps/items/:itemId/delete — remove a line item (D-102 fix:
//    was DELETE via ?_method=DELETE which silently no-op'd because method-override
//    isn't installed; clicks on × actually hit the POST update route below) ──
router.post('/projects/rfps/items/:itemId/delete', requireRfpEditAccess, async (req, res) => {
  // Resolve job_id BEFORE delete so we can redirect back to the right project
  const { data: lineItem, error: lineItemError } = await supabase
    .from('rfp_line_items')
    .select('rfp_id, parent_line_item_id, project_rfps(job_id)')
    .eq('id', req.params.itemId)
    .maybeSingle();
  if (lineItemError) throw lineItemError;
  const jobId = lineItem?.project_rfps?.job_id;
  await deleteRfpLineItemTree(req.params.itemId);
  if (jobId) return res.redirect(rfpRedirect(jobId, {
    open_rfp: lineItem?.rfp_id,
    open_item: lineItem?.parent_line_item_id || '',
  }));
  res.redirect('back');
});

// Keep DELETE handlers for any code paths that DO have method-override active
// (defensive — does no harm to define both):
router.delete('/projects/:id/rfps/:rId', requireRfpEditAccess, async (req, res) => {
  const { error: itemsError } = await supabase.from('rfp_line_items').delete().eq('rfp_id', req.params.rId);
  if (itemsError) throw itemsError;
  const { error: rfpError } = await supabase.from('project_rfps').delete().eq('id', req.params.rId).eq('job_id', req.params.id);
  if (rfpError) throw rfpError;
  res.redirect(`/projects/${req.params.id}/rfp`);
});
router.delete('/projects/rfps/items/:itemId', requireRfpEditAccess, async (req, res) => {
  await deleteRfpLineItemTree(req.params.itemId);
  res.json({ ok: true });
});

// ── POST /projects/rfps/items/:itemId — update a line item (D-101 inline edit) ──
router.post('/projects/rfps/items/:itemId', requireRfpEditAccess, async (req, res) => {
  // D-119 fix: when an HTML form has BOTH a hidden input (value="0") AND a
  // checkbox (value="1") sharing the same name, Express's qs body parser
  // returns an ARRAY of values. The previous code did `approved === '1'`
  // strict comparison which always failed on an array → approved never saved.
  // Normalize all req.body values: if array, take the LAST element (which is
  // the checkbox's "1" when checked, or just the hidden "0" when unchecked).
  function lastOf(v) { return Array.isArray(v) ? v[v.length - 1] : v; }
  const vendor = lastOf(req.body.vendor);
  const description = lastOf(req.body.description);
  const quantity = lastOf(req.body.quantity);
  const contractor_cost = lastOf(req.body.contractor_cost);
  const vendor_cost = lastOf(req.body.vendor_cost);
  const unit_cost = lastOf(req.body.unit_cost);
  const total_cost = lastOf(req.body.total_cost);
  const markup_pct = lastOf(req.body.markup_pct);
  const approved = lastOf(req.body.approved);
  let gr = req.body.general_requirements_pct;
  if (Array.isArray(gr)) gr = gr[gr.length - 1];

  const markup = parseFloat(markup_pct) || 20;
  const cCost = parseFloat(contractor_cost) || 0;
  // D-135: preserve existing vendor_cost when form no longer sends it (D-122b)
  const vCost = req.body.vendor_cost !== undefined ? (parseFloat(vendor_cost) || 0) : undefined;
  const uCost = parseFloat(unit_cost) || 0;
  const tCost = parseFloat(total_cost) || 0;
  const qty = parseFloat(quantity) || 0;

  // D-105: use computeSubLineTotals helper with general_requirements_pct
  let grParam = gr;
  var comp = computeSubLineTotals({ quantity, contractor_cost, vendor_cost, markup_pct, general_requirements_pct: grParam });
  var computedUnit = comp.unit_cost;
  var baseCost = comp.total_cost;
  var withMarkup = comp.total_with_markup;

  // First get the rfp_id so we can redirect back
  const { data: item, error: fetchError } = await supabase
    .from('rfp_line_items')
    .select('rfp_id, parent_line_item_id')
    .eq('id', req.params.itemId)
    .single();
  if (fetchError) throw fetchError;

  const { error } = await supabase
    .from('rfp_line_items')
    .update({
      vendor: vendor || null,
      description: description || '',
      quantity: qty || null,
      contractor_cost: cCost || null,
      unit_cost: computedUnit || null,
      total_cost: baseCost || null,
      markup_pct: markup,
      total_with_markup: withMarkup,
      final_unit_cost: baseCost > 0 ? withMarkup / (qty || 1) : 0,
      approved: approved === '1' || approved === 'true' || approved === 'on',
      general_requirements_pct: gr !== undefined ? (parseFloat(gr) || 6) : undefined,
      ...(req.body.vendor_cost !== undefined ? { vendor_cost: parseFloat(vendor_cost) || 0 } : {}),
      location: req.body.location || undefined,
      sort_order: req.body.sort_order !== undefined ? parseInt(req.body.sort_order) : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.itemId);
  if (error) throw error;

  // Get the RFP's job_id for redirect
  const { data: rfp, error: rfpError } = await supabase.from('project_rfps').select('job_id').eq('id', item.rfp_id).single();
  if (rfpError) throw rfpError;
  const jobId = rfp?.job_id || req.body.job_id;
  res.redirect(rfpRedirect(jobId, {
    open_rfp: item.rfp_id,
    open_item: item.parent_line_item_id || req.params.itemId,
  }));
});

// ── D-105: Sub-line item total computation helper ──
function computeSubLineTotals(params) {
  const qty = parseFloat(params.quantity) || 0;
  const cCost = parseFloat(params.contractor_cost) || 0;
  const vCost = parseFloat(params.vendor_cost) || 0;
  const markup = parseFloat(params.markup_pct) || 20;
  const gr = parseFloat(params.general_requirements_pct) !== undefined ? (parseFloat(params.general_requirements_pct) || 6) : 6;
  
  const computedUnit = cCost + vCost;
  const baseCost = computedUnit * qty;
  // D-140: Markup + GR are ADDITIVE percentages applied once, not compounding.
  const withMarkup = baseCost * (1 + (markup + gr) / 100);
  
  return {
    unit_cost: computedUnit,
    total_cost: baseCost,
    total_with_markup: withMarkup,
    final_unit_cost: qty > 0 ? withMarkup / qty : 0,
  };
}

// ── D-105: POST /projects/rfps/items/reorder — drag-drop save new sort order ──
router.post('/projects/rfps/items/reorder', requireRfpEditAccess, async (req, res) => {
  const { rfp_id } = req.body;
  let itemIds = req.body.item_ids;
  if (typeof itemIds === 'string' && itemIds.trim().startsWith('[')) {
    try { itemIds = JSON.parse(itemIds); } catch (e) { itemIds = []; }
  }
  if (typeof itemIds === 'string') itemIds = [itemIds];
  if (!Array.isArray(itemIds) || itemIds.length === 0) return res.status(400).json({ error: 'item_ids array required' });
  const updates = itemIds.map((id, i) => ({ id, sort_order: i }));
  for (const u of updates) {
    const { error } = await supabase.from('rfp_line_items').update({ sort_order: u.sort_order }).eq('id', u.id);
    if (error) throw error;
  }
  const { data: rfp, error: rfpError } = await supabase.from('project_rfps').select('job_id').eq('id', rfp_id).single();
  if (rfpError) throw rfpError;
  res.redirect(`/projects/${rfp?.job_id}/rfp`);
});

// ── F-007: POST /projects/rfps/items/:itemId/approve — AJAX toggle ──
router.post('/projects/rfps/items/:itemId/approve', requireRfpEditAccess, async (req, res) => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!itemId) return res.status(400).json({ ok: false, error: 'Invalid item id' });
  const approved = req.body.approved === 1 || req.body.approved === '1' || req.body.approved === true;
  const { error } = await supabase.from('rfp_line_items').update({ approved: approved ? 1 : 0 }).eq('id', itemId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, approved });
});

// ── F-006: RFP export routes (PDF, CSV, XLSX) ──────────────────────────
const rfpExport = require('../services/rfp-export');

async function loadProjectExportData(jobId) {
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('id, title')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return null;

  const { data: rfps, error: rfpsError } = await supabase
    .from('project_rfps')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (rfpsError) throw rfpsError;

  const rows = rfps || [];
  const itemsByRfp = {};
  rows.forEach(rfp => {
    itemsByRfp[rfp.id] = { items: [], subItemsMap: {} };
  });

  if (rows.length) {
    const { data: allItems, error: itemsError } = await supabase
      .from('rfp_line_items')
      .select('*')
      .in('rfp_id', rows.map(rfp => rfp.id))
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (itemsError) throw itemsError;

    (allItems || []).forEach(item => {
      const bucket = itemsByRfp[item.rfp_id];
      if (!bucket) return;
      if (item.parent_line_item_id) {
        (bucket.subItemsMap[item.parent_line_item_id] = bucket.subItemsMap[item.parent_line_item_id] || []).push(item);
      } else {
        bucket.items.push(item);
      }
    });
  }

  return { job, rfps: rows, itemsByRfp };
}

function exportFilenameBase(job, fallbackId) {
  const title = (job?.title || `project-${fallbackId}`).trim();
  const clean = title
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${clean || `project-${fallbackId}`}-RFP`;
}

router.get('/projects/:id/rfp/export.pdf', requireRfpAccess, async (req, res) => {
  const data = await loadProjectExportData(req.params.id);
  if (!data) return res.status(404).send('Project not found');
  const user = res.locals.currentUser;
  const buf = await rfpExport.renderProjectPdf(data.job, data.rfps, data.itemsByRfp, { createdBy: user?.name || '' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilenameBase(data.job, req.params.id)}.pdf"`);
  res.send(buf);
});

router.get('/projects/:id/rfp/export.csv', requireRfpAccess, async (req, res) => {
  const data = await loadProjectExportData(req.params.id);
  if (!data) return res.status(404).send('Project not found');
  const csv = rfpExport.renderProjectCsv(data.job, data.rfps, data.itemsByRfp);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilenameBase(data.job, req.params.id)}.csv"`);
  res.send(csv);
});

router.get('/projects/:id/rfp/export.xlsx', requireRfpAccess, async (req, res) => {
  const data = await loadProjectExportData(req.params.id);
  if (!data) return res.status(404).send('Project not found');
  const buf = await rfpExport.renderProjectXlsx(data.job, data.rfps, data.itemsByRfp);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilenameBase(data.job, req.params.id)}.xlsx"`);
  res.send(buf);
});

router.get('/projects/:id/rfps/:rId/export.pdf', requireRfpAccess, async (req, res) => {
  const { data: rfp, error: rfpErr } = await supabase.from('project_rfps').select('*, jobs!left(title)').eq('id', req.params.rId).maybeSingle();
  if (rfpErr) throw rfpErr;
  if (!rfp) return res.status(404).send('RFP not found');
  const { data: allItems, error: itemsErr } = await supabase.from('rfp_line_items').select('*').eq('rfp_id', rfp.id).order('sort_order');
  if (itemsErr) throw itemsErr;
  const items = allItems || [];
  const parentItems = items.filter(i => !i.parent_line_item_id);
  const subItemsMap = {};
  items.filter(i => i.parent_line_item_id).forEach(i => {
    (subItemsMap[i.parent_line_item_id] = subItemsMap[i.parent_line_item_id] || []).push(i);
  });
  const user = res.locals.currentUser;
  const buf = await rfpExport.renderPdf(rfp, parentItems, subItemsMap, { projectTitle: rfp.jobs?.title || '', createdBy: user?.name || '' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="rfp-${rfp.id}.pdf"`);
  res.send(buf);
});

router.get('/projects/:id/rfps/:rId/export.csv', requireRfpAccess, async (req, res) => {
  const { data: rfp, error: rfpErr } = await supabase.from('project_rfps').select('*').eq('id', req.params.rId).maybeSingle();
  if (rfpErr) throw rfpErr;
  if (!rfp) return res.status(404).send('RFP not found');
  const { data: allItems, error: itemsErr } = await supabase.from('rfp_line_items').select('*').eq('rfp_id', rfp.id).order('sort_order');
  if (itemsErr) throw itemsErr;
  const items = allItems || [];
  const parentItems = items.filter(i => !i.parent_line_item_id);
  const subItemsMap = {};
  items.filter(i => i.parent_line_item_id).forEach(i => {
    (subItemsMap[i.parent_line_item_id] = subItemsMap[i.parent_line_item_id] || []).push(i);
  });
  const csv = rfpExport.renderCsv(rfp, parentItems, subItemsMap);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="rfp-${rfp.id}.csv"`);
  res.send(csv);
});

router.get('/projects/:id/rfps/:rId/export.xlsx', requireRfpAccess, async (req, res) => {
  const { data: rfp, error: rfpErr } = await supabase.from('project_rfps').select('*').eq('id', req.params.rId).maybeSingle();
  if (rfpErr) throw rfpErr;
  if (!rfp) return res.status(404).send('RFP not found');
  const { data: allItems, error: itemsErr } = await supabase.from('rfp_line_items').select('*').eq('rfp_id', rfp.id).order('sort_order');
  if (itemsErr) throw itemsErr;
  const items = allItems || [];
  const parentItems = items.filter(i => !i.parent_line_item_id);
  const subItemsMap = {};
  items.filter(i => i.parent_line_item_id).forEach(i => {
    (subItemsMap[i.parent_line_item_id] = subItemsMap[i.parent_line_item_id] || []).push(i);
  });
  const buf = await rfpExport.renderXlsx(rfp, parentItems, subItemsMap);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="rfp-${rfp.id}.xlsx"`);
  res.send(buf);
});

module.exports = router;
