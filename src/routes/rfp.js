/**
 * RFP / Bid routes — contractor bid comparison for Projects.
 * Matches the RFP Template.xlsx structure: contractors submit line items
 * with vendor, costs, markup %, and final unit cost calculations.
 */
const express = require('express');
const supabase = require('../db/supabase');
const { requireManager } = require('../middleware/auth');

const router = express.Router();

// ── GET /projects/:id/rfps — list RFPs for a project ──
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

// ── GET /projects/:id/rfps/:rId/items — line items for an RFP ──
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
  res.redirect(`/projects/${req.params.id}?tab=rfp`);
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
  res.redirect(`/projects/${req.params.id}?tab=rfp`);
});

// ── DELETE /projects/:id/rfps/:rId — remove an RFP ──
router.delete('/projects/:id/rfps/:rId', requireManager, async (req, res) => {
  await supabase.from('rfp_line_items').delete().eq('rfp_id', req.params.rId);
  await supabase.from('project_rfps').delete().eq('id', req.params.rId);
  res.redirect(`/projects/${req.params.id}?tab=rfp`);
});

// ── DELETE /projects/rfps/items/:itemId — remove a line item ──
router.delete('/projects/rfps/items/:itemId', requireManager, async (req, res) => {
  await supabase.from('rfp_line_items').delete().eq('id', req.params.itemId);
  // Return JSON for HTMX-style deletion
  res.json({ ok: true });
});

module.exports = router;
