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
const DEFAULT_RFP_MARKUP_PCT = 16;
const DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT = 4;

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

function isMissingScopeTypeSchema(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('scope_type') || message.includes('schema cache');
}

async function insertRfpLineItem(payload) {
  const result = await supabase
    .from('rfp_line_items')
    .insert(payload)
    .select()
    .single();

  if (result.error && payload.scope_type && isMissingScopeTypeSchema(result.error)) {
    const { scope_type, ...fallbackPayload } = payload;
    console.warn('[rfp] scope_type column missing; inserting line item without material sync classification.');
    return supabase
      .from('rfp_line_items')
      .insert(fallbackPayload)
      .select()
      .single();
  }

  return result;
}

async function updateRfpLineItem(itemId, updateData) {
  let result = await supabase
    .from('rfp_line_items')
    .update(updateData)
    .eq('id', itemId);

  if (result.error && updateData.scope_type && isMissingScopeTypeSchema(result.error)) {
    const { scope_type, ...fallbackUpdate } = updateData;
    console.warn('[rfp] scope_type column missing; updating line item without material sync classification.');
    result = await supabase
      .from('rfp_line_items')
      .update(fallbackUpdate)
      .eq('id', itemId);
  }

  return result;
}

async function updateRfpLineItemAndSelect(itemId, updateData, selectColumns) {
  let result = await supabase
    .from('rfp_line_items')
    .update(updateData)
    .eq('id', itemId)
    .select(selectColumns)
    .single();

  if (result.error && updateData.scope_type && isMissingScopeTypeSchema(result.error)) {
    const { scope_type, ...fallbackUpdate } = updateData;
    console.warn('[rfp] scope_type column missing; autosaved line item without material sync classification.');
    result = await supabase
      .from('rfp_line_items')
      .update(fallbackUpdate)
      .eq('id', itemId)
      .select(selectColumns.replace(/,\s*scope_type/g, ''))
      .single();
    if (result.data && !('scope_type' in result.data)) result.data.scope_type = 'contractor';
  }

  return result;
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

async function resolveRfpJobId(req) {
  if (req.params.id) return req.params.id;

  if (req.params.itemId) {
    const { data: item, error } = await supabase
      .from('rfp_line_items')
      .select('id, rfp_id, project_rfps!inner(job_id)')
      .eq('id', req.params.itemId)
      .maybeSingle();
    if (error) throw error;
    return item?.project_rfps?.job_id || null;
  }

  if (req.body?.rfp_id) {
    const { data: rfp, error } = await supabase
      .from('project_rfps')
      .select('job_id')
      .eq('id', req.body.rfp_id)
      .maybeSingle();
    if (error) throw error;
    return rfp?.job_id || null;
  }

  const firstItemId = Array.isArray(req.body?.items) && req.body.items.length ? req.body.items[0]?.id : null;
  if (firstItemId) {
    const { data: item, error } = await supabase
      .from('rfp_line_items')
      .select('id, project_rfps!inner(job_id)')
      .eq('id', firstItemId)
      .maybeSingle();
    if (error) throw error;
    return item?.project_rfps?.job_id || null;
  }

  return null;
}

// ── Project-level access middleware for RFP routes ──
// Allows access if user is app admin, or has project-level operations access
// through assignment, project manager, or member role.
async function requireRfpAccess(req, res, next) {
  const appRole = req.session?.role;
  try {
    if (appRole === 'admin') return next();
    const jobId = await resolveRfpJobId(req);
    if (!jobId) return denyProjectAccess(res, 'Project ID required.');
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
  try {
    if (appRole === 'admin') return next();
    const jobId = await resolveRfpJobId(req);
    if (!jobId) return denyProjectAccess(res, 'Project ID required.');
    const { data: job } = await supabase.from('jobs').select('id, project_manager_user_id, assigned_to_user_id').eq('id', jobId).maybeSingle();
    if (!job) return denyProjectAccess(res, 'Project not found.');
    const access = await loadProjectAccess(req, job);
    if (access.canSeeOperations) return next();
    denyProjectAccess(res, 'You do not have permission to edit RFP data for this project.');
  } catch (e) {
    denyProjectAccess(res, 'Could not verify project access.');
  }
}

function normalizeAutosaveValue(field, value) {
  if (field === 'approved') return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
  if (['quantity', 'contractor_cost', 'vendor_cost', 'markup_pct', 'general_requirements_pct'].includes(field)) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return value == null ? '' : String(value);
}

function autosaveValuesMatch(field, a, b) {
  const left = normalizeAutosaveValue(field, a);
  const right = normalizeAutosaveValue(field, b);
  if (typeof left === 'number' || typeof right === 'number') return Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;
  return left === right;
}

function parseAutosaveField(field, value) {
  if (field === 'approved') return normalizeAutosaveValue(field, value);
  if (field === 'scope_type') return normalizeScopeType(value);
  if (['quantity', 'contractor_cost', 'vendor_cost', 'markup_pct', 'general_requirements_pct'].includes(field)) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field === 'description') return value == null ? '' : String(value);
  return value == null || value === '' ? null : String(value);
}

async function userCanEditRfpJob(req, job) {
  const appRole = req.session?.role;
  if (appRole === 'admin') return true;
  const access = await loadProjectAccess(req, job);
  return !!access.canSeeOperations;
}

function normalizeScopeType(value) {
  return String(value || '').toLowerCase() === 'supplier' ? 'supplier' : 'contractor';
}

function parseNumberOrDefault(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

async function loadRfpItemWithJob(itemId) {
  const { data, error } = await supabase
    .from('rfp_line_items')
    .select('id, rfp_id, parent_line_item_id, vendor, description, quantity, contractor_cost, vendor_cost, unit_cost, total_cost, markup_pct, general_requirements_pct, total_with_markup, final_unit_cost, approved, scope_type, updated_at, project_rfps!inner(id, job_id, jobs!inner(id, project_manager_user_id, assigned_to_user_id))')
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function buildLineItemAutosaveUpdate(item, field, value) {
  const allowed = ['vendor', 'description', 'quantity', 'contractor_cost', 'vendor_cost', 'markup_pct', 'general_requirements_pct', 'approved', 'scope_type'];
  if (!allowed.includes(field)) return null;

  const parsed = parseAutosaveField(field, value);
  const updateData = { [field]: parsed, updated_at: new Date().toISOString() };

  if (['quantity', 'contractor_cost', 'vendor_cost', 'markup_pct', 'general_requirements_pct'].includes(field)) {
    const next = { ...item, [field]: parsed };
    const computed = computeSubLineTotals(next);
    updateData.unit_cost = computed.unit_cost || null;
    updateData.total_cost = computed.total_cost || null;
    updateData.total_with_markup = computed.total_with_markup || null;
    updateData.final_unit_cost = computed.final_unit_cost || null;
  }

  return updateData;
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

  // D-142: bidder invitations — who a category's unpriced SOW PDF should be
  // addressed to, independent of any priced pricing sub-lines.
  let rfpInvitationsMap = {};
  if (rfps && rfps.length) {
    try {
      const rfpIds = rfps.map(r => r.id);
      const { data: allInvitations, error: invitationsError } = await supabase
        .from('rfp_bid_invitations')
        .select('*')
        .in('rfp_id', rfpIds)
        .order('created_at', { ascending: true });
      if (invitationsError) throw invitationsError;
      (allInvitations || []).forEach(inv => {
        (rfpInvitationsMap[inv.rfp_id] = rfpInvitationsMap[inv.rfp_id] || []).push(inv);
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
    rfpInvitationsMap,
    customers: job.customers || {},
    vendors: sources.vendors,
    contractors: sources.contractors,
  });
});

// ── D-142: POST /projects/:id/rfps/:rId/invitations — add a bid invitee ──
router.post('/projects/:id/rfps/:rId/invitations', requireRfpEditAccess, async (req, res) => {
  const rfpId = req.params.rId;
  const raw = String(req.body.recipient || '').trim();
  if (!raw) return res.redirect(rfpRedirect(req.params.id, { open_rfp: rfpId }));

  // recipient value is "contractor:<id>:<name>" / "vendor:<id>:<name>" from
  // the combined picker, or just a plain typed name with no picker match.
  let recipientType = null;
  let recipientId = null;
  let recipientName = raw;
  const match = raw.match(/^(contractor|vendor):(\d*):(.*)$/);
  if (match) {
    recipientType = match[1];
    recipientId = match[2] ? parseInt(match[2], 10) : null;
    recipientName = match[3];
  }
  if (!recipientName) return res.redirect(rfpRedirect(req.params.id, { open_rfp: rfpId }));

  const insertPayload = {
    rfp_id: rfpId,
    recipient_name: recipientName,
    recipient_type: recipientType,
    contractor_id: recipientType === 'contractor' ? recipientId : null,
    vendor_id: recipientType === 'vendor' ? recipientId : null,
    created_by_user_id: req.session?.userId || null,
  };
  const { error } = await supabase.from('rfp_bid_invitations').insert(insertPayload);
  if (error) throw error;
  res.redirect(rfpRedirect(req.params.id, { open_rfp: rfpId }));
});

// ── D-142: POST /projects/:id/rfps/:rId/invitations/:invId/delete ──
router.post('/projects/:id/rfps/:rId/invitations/:invId/delete', requireRfpEditAccess, async (req, res) => {
  const { error } = await supabase
    .from('rfp_bid_invitations')
    .delete()
    .eq('id', req.params.invId)
    .eq('rfp_id', req.params.rId);
  if (error) throw error;
  res.redirect(rfpRedirect(req.params.id, { open_rfp: req.params.rId }));
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
  const { status, contractor_name, notes } = req.body;
  const updateFields = { updated_at: new Date().toISOString() };
  const validStatuses = ['pending', 'submitted', 'awarded', 'declined'];
  if (status && validStatuses.includes(status)) {
    updateFields.status = status;
  }
  if (contractor_name && contractor_name.trim()) {
    updateFields.contractor_name = contractor_name.trim();
  }
  if (notes !== undefined) {
    updateFields.notes = String(notes || '').trim() || null;
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

// ── PATCH /projects/:id/rfps/:rId/autosave — field-level category autosave ──
router.patch('/projects/:id/rfps/:rId/autosave', requireAuth, requireRfpEditAccess, async (req, res) => {
  const { field, value, originalValue } = req.body || {};
  const allowed = ['contractor_name', 'status', 'notes'];
  const validStatuses = ['pending', 'submitted', 'awarded', 'declined'];
  if (!allowed.includes(field)) return res.status(400).json({ ok: false, error: 'Unsupported field.' });
  if (field === 'status' && !validStatuses.includes(String(value))) return res.status(400).json({ ok: false, error: 'Invalid status.' });

  const { data: rfp, error: fetchError } = await supabase
    .from('project_rfps')
    .select('id, job_id, contractor_name, status, notes, updated_at')
    .eq('id', req.params.rId)
    .eq('job_id', req.params.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ ok: false, error: fetchError.message });
  if (!rfp) return res.status(404).json({ ok: false, error: 'RFP category not found.' });

  if (originalValue !== undefined && !autosaveValuesMatch(field, rfp[field], originalValue)) {
    return res.status(409).json({
      ok: false,
      conflict: true,
      field,
      currentValue: rfp[field] ?? '',
      currentUpdatedAt: rfp.updated_at || null,
    });
  }

  const nextValue = field === 'contractor_name' ? String(value || '').trim() : String(value || '').trim();
  if (field === 'contractor_name' && !nextValue) return res.status(400).json({ ok: false, error: 'Category name is required.' });

  const { data: updated, error } = await supabase
    .from('project_rfps')
    .update({ [field]: field === 'notes' ? (nextValue || null) : nextValue, updated_at: new Date().toISOString() })
    .eq('id', req.params.rId)
    .eq('job_id', req.params.id)
    .select('id, contractor_name, status, notes, updated_at')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, rfp: updated });
});

// ── POST /projects/:id/rfps/:rId/items — add line item ──
router.post('/projects/:id/rfps/:rId/items', requireRfpEditAccess, async (req, res) => {
  const { vendor, description, quantity, contractor_cost, vendor_cost,
          unit_cost, total_cost, markup_pct, parent_id, scope_type } = req.body;
  const approvedInput = Array.isArray(req.body.approved) ? req.body.approved[req.body.approved.length - 1] : req.body.approved;

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

  const markup = parseNumberOrDefault(markup_pct, DEFAULT_RFP_MARKUP_PCT);
  const cCost = parseNumberOrDefault(contractor_cost, 0);
  const vCost = parseNumberOrDefault(vendor_cost, 0);
  const uCost = parseNumberOrDefault(unit_cost, 0);
  const tCost = parseNumberOrDefault(total_cost, 0);
  const qty = parseNumberOrDefault(quantity, 0);
  // D-140: GR is read from the request; blank new lines use the current default.
  const gr = parseFloat(req.body.general_requirements_pct);
  const grPct = isFinite(gr) ? gr : DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT;

  const computed = computeSubLineTotals({ quantity, contractor_cost, vendor_cost, markup_pct, general_requirements_pct: grPct });
  const computedUnit = computed.unit_cost;
  let baseCost = computed.total_cost;
  let withMarkup = computed.total_with_markup;
  let finalUnitCost = computed.final_unit_cost;

  if (!parent_id) {
    // D-140: Markup and GR are ADDITIVE percentages applied once — not compounding.
    //   total_with_markup = total_cost × (1 + (markup% + gr%) / 100)
    baseCost = tCost || (uCost * qty) || computed.total_cost;
    withMarkup = baseCost * (1 + (markup + grPct) / 100);
    finalUnitCost = baseCost > 0 ? withMarkup / (qty || 1) : 0;
  }

  const insertPayload = {
    rfp_id: req.params.rId,
    parent_line_item_id: parent_id || null,
    vendor: vendor || null,
    description: description || '',
    quantity: qty || null,
    contractor_cost: cCost || null,
    vendor_cost: vCost || null,
    unit_cost: parent_id ? (computedUnit || null) : (uCost || computedUnit || null),
    total_cost: baseCost || null,
    markup_pct: markup,
    general_requirements_pct: grPct,
    total_with_markup: withMarkup,
    final_unit_cost: finalUnitCost,
    scope_type: parent_id ? normalizeScopeType(scope_type) : 'contractor',
  };
  if (parent_id) {
    insertPayload.approved = approvedInput === undefined ? true : (approvedInput === '1' || approvedInput === 'true' || approvedInput === true || approvedInput === 'on');
  }

  const { data, error } = await insertRfpLineItem(insertPayload);
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

// ── D-105: POST /projects/rfps/items/reorder — drag-drop save new sort order ──
// NOTE: must be registered BEFORE the generic '/:itemId' route below — Express
// matches routes in declaration order, and '/:itemId' matches the literal
// segment "reorder" just as well as a numeric id, silently swallowing this
// route otherwise (drag-drop reorder would appear to work client-side but
// never actually persist, so it reverted after refresh).
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

// ── Bulk save all RFP line items — POST /projects/rfps/items/bulk-save ──
// Same route-ordering note as '/reorder' above — must precede '/:itemId'.
router.post('/projects/rfps/items/bulk-save', requireRfpEditAccess, async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'items array is required' });
  }

  function lastOf(v) { return Array.isArray(v) ? v[v.length - 1] : v; }

  const results = { saved: 0, errors: [] };

  for (const entry of items) {
    const itemId = parseInt(entry.id, 10);
    if (!itemId) { results.errors.push({ id: entry.id, error: 'Invalid item id' }); continue; }

    const vendor = lastOf(entry.vendor);
    const description = lastOf(entry.description);
    const quantity = lastOf(entry.quantity);
    const contractor_cost = lastOf(entry.contractor_cost);
    const vendor_cost = lastOf(entry.vendor_cost);
    const markup_pct = lastOf(entry.markup_pct);
    const general_requirements_pct = lastOf(entry.general_requirements_pct);
    const approved = lastOf(entry.approved);

    const markup = parseNumberOrDefault(markup_pct, DEFAULT_RFP_MARKUP_PCT);
    const cCost = parseNumberOrDefault(contractor_cost, 0);
    const vCost = parseNumberOrDefault(vendor_cost, 0);
    const qty = parseNumberOrDefault(quantity, 0);
    const gr = parseFloat(general_requirements_pct);
    const grPct = isFinite(gr) ? gr : DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT;

    const computedUnit = cCost + vCost;
    const baseCost = computedUnit * qty;
    const withMarkup = baseCost * (1 + (markup + grPct) / 100);

    const updateData = {};
    if (vendor !== undefined) updateData.vendor = vendor || null;
    if (description !== undefined) updateData.description = description || '';
    if (quantity !== undefined) updateData.quantity = qty || null;
    if (contractor_cost !== undefined) updateData.contractor_cost = cCost || null;
    updateData.unit_cost = computedUnit || null;
    updateData.total_cost = baseCost || null;
    updateData.markup_pct = markup;
    updateData.total_with_markup = withMarkup;
    updateData.final_unit_cost = baseCost > 0 ? withMarkup / (qty || 1) : 0;
    if (general_requirements_pct !== undefined) updateData.general_requirements_pct = grPct;
    if (approved !== undefined) updateData.approved = approved === '1' || approved === 'true' || approved === true;
    updateData.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('rfp_line_items')
      .update(updateData)
      .eq('id', itemId);

    if (error) {
      results.errors.push({ id: itemId, error: error.message });
    } else {
      results.saved++;
    }
  }

  res.json({ ok: true, ...results });
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
  function hasField(name) { return Object.prototype.hasOwnProperty.call(req.body || {}, name); }
  const vendor = lastOf(req.body.vendor);
  const description = lastOf(req.body.description);
  const quantity = lastOf(req.body.quantity);
  const contractor_cost = lastOf(req.body.contractor_cost);
  const vendor_cost = lastOf(req.body.vendor_cost);
  const markup_pct = lastOf(req.body.markup_pct);
  const approved = lastOf(req.body.approved);
  const scope_type = lastOf(req.body.scope_type);
  let gr = req.body.general_requirements_pct;
  if (Array.isArray(gr)) gr = gr[gr.length - 1];

  // First get the rfp_id so we can redirect back
  const { data: item, error: fetchError } = await supabase
    .from('rfp_line_items')
    .select('id, rfp_id, parent_line_item_id, vendor, description, quantity, contractor_cost, vendor_cost, markup_pct, general_requirements_pct, approved, scope_type')
    .eq('id', req.params.itemId)
    .single();
  if (fetchError) throw fetchError;

  const next = {
    vendor: hasField('vendor') ? (vendor || null) : item.vendor,
    description: hasField('description') ? (description || '') : item.description,
    quantity: hasField('quantity') ? parseNumberOrDefault(quantity, 0) : parseNumberOrDefault(item.quantity, 0),
    contractor_cost: hasField('contractor_cost') ? parseNumberOrDefault(contractor_cost, 0) : parseNumberOrDefault(item.contractor_cost, 0),
    vendor_cost: hasField('vendor_cost') ? parseNumberOrDefault(vendor_cost, 0) : parseNumberOrDefault(item.vendor_cost, 0),
    markup_pct: hasField('markup_pct') ? parseNumberOrDefault(markup_pct, DEFAULT_RFP_MARKUP_PCT) : parseNumberOrDefault(item.markup_pct, DEFAULT_RFP_MARKUP_PCT),
    general_requirements_pct: hasField('general_requirements_pct') ? parseNumberOrDefault(gr, DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT) : parseNumberOrDefault(item.general_requirements_pct, DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT),
    approved: hasField('approved') ? (approved === '1' || approved === 'true' || approved === 'on') : !!item.approved,
    scope_type: hasField('scope_type') ? normalizeScopeType(scope_type) : item.scope_type,
  };

  const comp = computeSubLineTotals(next);

  const { error } = await updateRfpLineItem(req.params.itemId, {
    vendor: next.vendor,
    description: next.description,
    quantity: next.quantity || null,
    contractor_cost: next.contractor_cost || null,
    vendor_cost: next.vendor_cost || null,
    unit_cost: comp.unit_cost || null,
    total_cost: comp.total_cost || null,
    markup_pct: next.markup_pct,
    general_requirements_pct: next.general_requirements_pct,
    total_with_markup: comp.total_with_markup,
    final_unit_cost: comp.final_unit_cost,
    approved: next.approved,
    ...(next.scope_type !== undefined ? { scope_type: normalizeScopeType(next.scope_type) } : {}),
    location: req.body.location || undefined,
    sort_order: req.body.sort_order !== undefined ? parseInt(req.body.sort_order) : undefined,
    updated_at: new Date().toISOString(),
  });
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

// ── PATCH /projects/rfps/items/:itemId/autosave — field-level line-item autosave ──
router.patch('/projects/rfps/items/:itemId/autosave', requireAuth, async (req, res) => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!itemId) return res.status(400).json({ ok: false, error: 'Invalid item id.' });

  const { field, value, originalValue } = req.body || {};
  const updateData = buildLineItemAutosaveUpdate({}, field, value);
  if (!updateData) return res.status(400).json({ ok: false, error: 'Unsupported field.' });

  let item;
  try {
    item = await loadRfpItemWithJob(itemId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  if (!item) return res.status(404).json({ ok: false, error: 'RFP line item not found.' });

  try {
    const job = item.project_rfps?.jobs;
    if (!job || !(await userCanEditRfpJob(req, job))) {
      return res.status(403).json({ ok: false, error: 'You do not have permission to edit this RFP item.' });
    }
  } catch (e) {
    return res.status(403).json({ ok: false, error: 'Could not verify project access.' });
  }

  if (originalValue !== undefined && !autosaveValuesMatch(field, item[field], originalValue)) {
    return res.status(409).json({
      ok: false,
      conflict: true,
      field,
      currentValue: item[field] ?? '',
      currentUpdatedAt: item.updated_at || null,
    });
  }

  const nextUpdateData = buildLineItemAutosaveUpdate(item, field, value);
  const { data: updated, error } = await updateRfpLineItemAndSelect(
    itemId,
    nextUpdateData,
    'id, vendor, description, quantity, contractor_cost, vendor_cost, unit_cost, total_cost, markup_pct, general_requirements_pct, total_with_markup, final_unit_cost, approved, scope_type, updated_at'
  );
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, item: updated });
});

// ── D-105: Sub-line item total computation helper ──
function computeSubLineTotals(params) {
  const qty = parseNumberOrDefault(params.quantity, 0);
  const cCost = parseNumberOrDefault(params.contractor_cost, 0);
  const vCost = parseNumberOrDefault(params.vendor_cost, 0);
  const markup = parseNumberOrDefault(params.markup_pct, DEFAULT_RFP_MARKUP_PCT);
  const gr = parseNumberOrDefault(params.general_requirements_pct, DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT);
  
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

function selectedBidRequestItemIds(queryValue) {
  const raw = Array.isArray(queryValue) ? queryValue : [queryValue];
  return raw
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
}

function cleanFilenamePart(value, fallback, maxLength = 60) {
  const clean = String(value || fallback)
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return clean || fallback;
}

router.get('/projects/:id/rfp/bid-request.pdf', requireRfpAccess, async (req, res) => {
  const itemIds = selectedBidRequestItemIds(req.query.item_ids);
  if (!itemIds.length) return res.status(400).send('Select at least one line item for the bid request PDF.');

  const [{ data: job, error: jobErr }, { data: items, error: itemsErr }] = await Promise.all([
    supabase.from('jobs').select('id, title, name, address, city, state, zip').eq('id', req.params.id).maybeSingle(),
    supabase
      .from('rfp_line_items')
      .select('*, project_rfps!inner(id, job_id, contractor_name, notes, created_at)')
      .in('id', itemIds)
      .is('parent_line_item_id', null)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
  ]);
  if (jobErr) throw jobErr;
  if (itemsErr) throw itemsErr;
  if (!job) return res.status(404).send('Project not found');

  const selectedItems = (items || []).filter(item => String(item.project_rfps?.job_id) === String(req.params.id));
  if (selectedItems.length !== itemIds.length) {
    return res.status(404).send('One or more selected bid request line items were not found for this project.');
  }

  const recipientName = String(req.query.for || '').trim() || null;
  const buf = await rfpExport.renderSelectedBidRequestPdf(job, selectedItems, recipientName);
  const cleanProject = exportFilenameBase(job, req.params.id).replace(/-RFP$/, '');
  const cleanRecipient = recipientName ? '-' + cleanFilenamePart(recipientName, 'recipient', 40) : '';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${cleanProject}-selected-scope${cleanRecipient}-bid-request.pdf"`);
  res.send(buf);
});

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

// ── Ginosko Bid Sheet export — fills approved RFP pricing into Ginosko's
// Exhibit B template. See src/services/ginosko-export.js for the cell
// mapping (GINOSKO_TEMPLATE), the reconciliation guard, and the notes on
// what to update if Ginosko revises the workbook. ──
const ginoskoExport = require('../services/ginosko-export');

// loadProjectExportData() (above) only selects jobs.id/title — enough for
// the plain PDF/CSV/XLSX exports, which don't print an address or dates.
// The Ginosko template does, so Ginosko exports fetch the job separately
// with the fuller field set rather than widening the shared loader (which
// would touch the existing exports' behavior).
async function loadGinoskoJob(jobId) {
  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, title, address, city, state, zip, start_date, end_date')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return job;
}

function sendGinoskoWorkbookErrors(res, jobIdForLog, e) {
  if (e instanceof ginoskoExport.GinoskoTemplateMissingError) {
    console.error('[ginosko-export] template missing:', e.message);
    res.status(500).send('Ginosko bid sheet template is not available on the server. Contact an administrator.');
    return true;
  }
  if (e instanceof ginoskoExport.GinoskoReconciliationError) {
    console.error('[ginosko-export] reconciliation mismatch for job', jobIdForLog, e.details);
    res.status(500).send(
      'Ginosko export aborted: the workbook total did not match the approved FORGE RFP total, so nothing was downloaded. ' +
      `FORGE approved total: $${e.details.forgeTotal.toFixed(2)}, expected workbook total: $${e.details.workbookTotal.toFixed(2)}, difference: $${e.details.diff.toFixed(2)}. ` +
      'Please review the RFP approvals for this project and try again, or contact an administrator.'
    );
    return true;
  }
  return false;
}

function sendGinoskoWorkbook(res, result) {
  const asciiFallback = result.filename.replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'");
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.send(Buffer.from(result.buffer));
}

// Whole-project export — every RFP category on the project rolled into one
// bid sheet. Kept for convenience; most projects only have one category
// anyway. For a single trade/category, use the per-category route below.
router.get('/projects/:id/rfp/export-ginosko.xlsx', requireRfpAccess, async (req, res) => {
  const [job, data] = await Promise.all([
    loadGinoskoJob(req.params.id),
    loadProjectExportData(req.params.id),
  ]);
  if (!job || !data) return res.status(404).send('Project not found');

  let result;
  try {
    result = await ginoskoExport.buildGinoskoExport(job, data.rfps, data.itemsByRfp);
  } catch (e) {
    if (sendGinoskoWorkbookErrors(res, req.params.id, e)) return;
    throw e;
  }

  sendGinoskoWorkbook(res, result);
});

// Per-category export — the normal path: generates a bid sheet scoped to
// exactly one selected RFP category (the "Ginosko" link on that category's
// row), so a project with multiple trades/categories gets one Exhibit B
// per trade instead of everything merged into a single sheet.
router.get('/projects/:id/rfps/:rId/export-ginosko.xlsx', requireRfpAccess, async (req, res) => {
  const [job, { data: rfp, error: rfpErr }] = await Promise.all([
    loadGinoskoJob(req.params.id),
    supabase.from('project_rfps').select('*').eq('id', req.params.rId).maybeSingle(),
  ]);
  if (rfpErr) throw rfpErr;
  if (!job) return res.status(404).send('Project not found');
  // Defensive cross-project guard: requireRfpAccess authorizes based on
  // req.params.id, so make sure the requested category actually belongs
  // to that project before exporting anything from it.
  if (!rfp || String(rfp.job_id) !== String(req.params.id)) {
    return res.status(404).send('RFP category not found for this project.');
  }

  const { data: allItems, error: itemsErr } = await supabase
    .from('rfp_line_items')
    .select('*')
    .eq('rfp_id', rfp.id)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (itemsErr) throw itemsErr;

  const items = allItems || [];
  const parentItems = items.filter(i => !i.parent_line_item_id);
  const subItemsMap = {};
  items.filter(i => i.parent_line_item_id).forEach(i => {
    (subItemsMap[i.parent_line_item_id] = subItemsMap[i.parent_line_item_id] || []).push(i);
  });

  let result;
  try {
    result = await ginoskoExport.buildGinoskoExport(job, [rfp], { [rfp.id]: { items: parentItems, subItemsMap } });
  } catch (e) {
    if (sendGinoskoWorkbookErrors(res, req.params.id, e)) return;
    throw e;
  }

  sendGinoskoWorkbook(res, result);
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

router.get('/projects/:id/rfps/:rId/bid-request.pdf', requireRfpAccess, async (req, res) => {
  const [{ data: job, error: jobErr }, { data: rfp, error: rfpErr }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', req.params.id).maybeSingle(),
    supabase.from('project_rfps').select('*').eq('id', req.params.rId).eq('job_id', req.params.id).maybeSingle(),
  ]);
  if (jobErr) throw jobErr;
  if (rfpErr) throw rfpErr;
  if (!job || !rfp) return res.status(404).send('RFP not found');

  const { data: items, error: itemsErr } = await supabase
    .from('rfp_line_items')
    .select('*')
    .eq('rfp_id', rfp.id)
    .is('parent_line_item_id', null)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (itemsErr) throw itemsErr;

  const recipientName = String(req.query.for || '').trim() || null;
  const buf = await rfpExport.renderBidRequestPdf(job, rfp, items || [], recipientName);
  const cleanProject = exportFilenameBase(job, req.params.id).replace(/-RFP$/, '');
  const cleanCategory = String(rfp.contractor_name || `rfp-${rfp.id}`)
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `rfp-${rfp.id}`;
  const cleanRecipient = recipientName
    ? '-' + recipientName.replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    : '';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${cleanProject}-${cleanCategory}${cleanRecipient}-bid-request.pdf"`);
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
