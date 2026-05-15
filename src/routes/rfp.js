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

  const [{ data: job, error: jobError }, { data: rfps, error: rfpsError }, { data: vendorsResult, error: vendorsError }, { data: contractorsResult, error: contractorsError }] = await Promise.all([
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
  if (vendorsError) throw vendorsError;
  if (contractorsError) throw contractorsError;
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

  res.render('jobs/rfp', {
    title: 'RFP — ' + (job.title || job.name),
    activeNav: 'projects',
    job,
    rfps: rfpsError ? [] : (rfps || []),
    rfpItemsMap,
    customers: job.customers || {},
    vendors: vendorsResult || [],
    contractors: contractorsResult || [],
  });
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

// ── POST /projects/:id/rfps/:rId — update RFP status ──
router.post('/projects/:id/rfps/:rId', requireManager, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'submitted', 'awarded', 'declined'];
  if (status && validStatuses.includes(status)) {
    const { error } = await supabase
      .from('project_rfps')
      .update({ status, updated_at: new Date().toISOString() })
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

// ── DELETE /projects/:id/rfps/:rId — remove an RFP ──
router.delete('/projects/:id/rfps/:rId', requireManager, async (req, res) => {
  const { error: itemsError } = await supabase.from('rfp_line_items').delete().eq('rfp_id', req.params.rId);
  if (itemsError) throw itemsError;
  const { error: rfpError } = await supabase.from('project_rfps').delete().eq('id', req.params.rId).eq('job_id', req.params.id);
  if (rfpError) throw rfpError;
  res.redirect(`/projects/${req.params.id}/rfp`);
});

// ── DELETE /projects/rfps/items/:itemId — remove a line item ──
router.delete('/projects/rfps/items/:itemId', requireManager, async (req, res) => {
  const { error } = await supabase.from('rfp_line_items').delete().eq('id', req.params.itemId);
  if (error) throw error;
  res.json({ ok: true });
});

module.exports = router;
