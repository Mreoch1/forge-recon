/**
 * RFP / Bid routes — contractor bid comparison for Projects.
 * Matches the RFP Template.xlsx structure: contractors submit line items
 * with vendor, costs, markup %, and final unit cost calculations.
 *
 * Routes mounted at / under requireAuth.
 */
const express = require('express');
const supabase = require('../db/supabase');
const { requireManager } = require('../middleware/auth');

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

// ── GET /projects/:id/rfp — dedicated RFP management page for a project ──
router.get('/projects/:id/rfp', async (req, res) => {
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
router.get('/api/rfp-sources', async (req, res) => {
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
router.get('/projects/:id/rfps', async (req, res) => {
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
router.get('/projects/:id/rfps/:rId/items', async (req, res) => {
  const { data: items, error } = await supabase
    .from('rfp_line_items')
    .select('*')
    .eq('rfp_id', req.params.rId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  res.json(items || []);
});

// ── POST /projects/:id/rfps — create a new RFP ──
router.post('/projects/:id/rfps', requireManager, async (req, res) => {
  const { contractor_name, notes } = req.body;
  const { data, error } = await supabase
    .from('project_rfps')
    .insert({
      job_id: req.params.id,
      contractor_name: contractor_name || 'New Contractor',
      notes: notes || null,
      created_by_user_id: req.session.userId || req.user?.id || null,
    })
    .select()
    .single();
  if (error) throw error;
  res.redirect(`/projects/${req.params.id}/rfp`);
});

// ── POST /projects/:id/rfps/:rId — update RFP status or rename category (D-101) ──
router.post('/projects/:id/rfps/:rId', requireManager, async (req, res) => {
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
  res.redirect(`/projects/${req.params.id}/rfp`);
});

// ── POST /projects/:id/rfps/:rId/items — add line item ──
router.post('/projects/:id/rfps/:rId/items', requireManager, async (req, res) => {
  const { vendor, description, quantity, contractor_cost, vendor_cost,
          unit_cost, total_cost, markup_pct, parent_id } = req.body;

  const markup = parseFloat(markup_pct) || 20;
  const cCost = parseFloat(contractor_cost) || 0;
  const vCost = parseFloat(vendor_cost) || 0;
  const uCost = parseFloat(unit_cost) || 0;
  const tCost = parseFloat(total_cost) || 0;
  const qty = parseFloat(quantity) || 0;

  // Auto-calculate total_with_markup: (total_cost + contractor_cost) * (1 + markup/100) * 1.06
  const baseCost = tCost || (uCost * qty) || (cCost + vCost);
  const withMarkup = baseCost * (1 + markup / 100) * 1.06;

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
      total_with_markup: withMarkup,
      final_unit_cost: baseCost > 0 ? withMarkup / (qty || 1) : 0,
    })
    .select()
    .single();
  if (error) throw error;
  res.redirect(`/projects/${req.params.id}/rfp`);
});

// ── POST /projects/:id/rfps/:rId/delete — remove an RFP (POST + suffix path because
//    method-override middleware isn't installed; ?_method=DELETE doesn't work) ──
router.post('/projects/:id/rfps/:rId/delete', requireManager, async (req, res) => {
  const { error: itemsError } = await supabase.from('rfp_line_items').delete().eq('rfp_id', req.params.rId);
  if (itemsError) throw itemsError;
  const { error: rfpError } = await supabase.from('project_rfps').delete().eq('id', req.params.rId).eq('job_id', req.params.id);
  if (rfpError) throw rfpError;
  res.redirect(`/projects/${req.params.id}/rfp`);
});

// ── POST /projects/rfps/items/:itemId/delete — remove a line item (D-102 fix:
//    was DELETE via ?_method=DELETE which silently no-op'd because method-override
//    isn't installed; clicks on × actually hit the POST update route below) ──
router.post('/projects/rfps/items/:itemId/delete', requireManager, async (req, res) => {
  // Resolve job_id BEFORE delete so we can redirect back to the right project
  const { data: lineItem } = await supabase
    .from('rfp_line_items')
    .select('rfp_id, project_rfps(job_id)')
    .eq('id', req.params.itemId)
    .maybeSingle();
  const jobId = lineItem?.project_rfps?.job_id;
  const { error } = await supabase.from('rfp_line_items').delete().eq('id', req.params.itemId);
  if (error) throw error;
  if (jobId) return res.redirect(`/projects/${jobId}/rfp`);
  res.redirect('back');
});

// Keep DELETE handlers for any code paths that DO have method-override active
// (defensive — does no harm to define both):
router.delete('/projects/:id/rfps/:rId', requireManager, async (req, res) => {
  const { error: itemsError } = await supabase.from('rfp_line_items').delete().eq('rfp_id', req.params.rId);
  if (itemsError) throw itemsError;
  const { error: rfpError } = await supabase.from('project_rfps').delete().eq('id', req.params.rId).eq('job_id', req.params.id);
  if (rfpError) throw rfpError;
  res.redirect(`/projects/${req.params.id}/rfp`);
});
router.delete('/projects/rfps/items/:itemId', requireManager, async (req, res) => {
  const { error } = await supabase.from('rfp_line_items').delete().eq('id', req.params.itemId);
  if (error) throw error;
  res.json({ ok: true });
});

// ── POST /projects/rfps/items/:itemId — update a line item (D-101 inline edit) ──
router.post('/projects/rfps/items/:itemId', requireManager, async (req, res) => {
  const { vendor, description, quantity, contractor_cost, vendor_cost,
          unit_cost, total_cost, markup_pct } = req.body;

  const markup = parseFloat(markup_pct) || 20;
  const cCost = parseFloat(contractor_cost) || 0;
  const vCost = parseFloat(vendor_cost) || 0;
  const uCost = parseFloat(unit_cost) || 0;
  const tCost = parseFloat(total_cost) || 0;
  const qty = parseFloat(quantity) || 0;

  const baseCost = tCost || (uCost * qty) || (cCost + vCost);
  const withMarkup = baseCost * (1 + markup / 100) * 1.06;

  // First get the rfp_id so we can redirect back
  const { data: item, error: fetchError } = await supabase
    .from('rfp_line_items')
    .select('rfp_id')
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
      vendor_cost: vCost || null,
      unit_cost: uCost || null,
      total_cost: baseCost || null,
      markup_pct: markup,
      total_with_markup: withMarkup,
      final_unit_cost: baseCost > 0 ? withMarkup / (qty || 1) : 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.itemId);
  if (error) throw error;

  // Get the RFP's job_id for redirect
  const { data: rfp } = await supabase.from('project_rfps').select('job_id').eq('id', item.rfp_id).single();
  const jobId = rfp?.job_id || req.body.job_id;
  res.redirect(`/projects/${jobId}/rfp`);
});

module.exports = router;
