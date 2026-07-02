/**
 * Work Orders CRUD — Supabase SDK.
 *
 * WO is the ROOT document: customer -> job -> WO -> estimate -> invoice.
 *
 *   GET  /                          list (search + status filter + paging)
 *   GET  /new?project_id=N          new root WO form, optionally prelinked to a project
 *   POST /                          create (uses create_work_order_with_lines RPC)
 *   GET  /ai-create                 AI-assisted WO form
 *   POST /ai-create                 parse free text into structured WO + render preview
 *   POST /ai-finalize               commit the AI extraction (RPC)
 */

// --- new (must come before /:id) ---

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const calc = require('../services/calculations');
const numbering = require('../services/numbering');
const storage = require('../services/storage');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { listEntityActivity } = require('../services/activity');

// PDF service is optional in some envs — wrap import so test boots don't fail
let pdf;
try { pdf = require('../services/pdf'); } catch (e) { pdf = null; }

const router = express.Router();

// --- constants ---

const PAGE_SIZE = 25;
const VALID_STATUSES = ['open', 'scheduled', 'in_progress', 'closed', 'complete', 'cancelled'];
const VALID_UNITS = ['ea', 'hr', 'sqft', 'lf', 'ton', 'lot'];

// File upload: multer memory storage, validation — accept any non-executable file type
const WO_BLOCKED_EXTENSIONS = new Set(['.app', '.bat', '.cmd', '.com', '.dll', '.dmg', '.exe', '.js', '.msi', '.ps1', '.scr', '.sh']);
const MAX_SIZE = 25 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_DIRECT_FILES = 150;
const woUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (WO_BLOCKED_EXTENSIONS.has(ext)) cb(new Error('File type not allowed: ' + ext));
    else cb(null, true);
  }
});

// --- helpers ---

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function woAttachmentDisplayName(file) {
  return file?.original_filename || String(file?.filename || '').split('/').pop() || 'File';
}

function safeAttachmentName(file) {
  return woAttachmentDisplayName(file).replace(/[\r\n"\\]/g, '_');
}

function contentDisposition(disposition, file) {
  const filename = safeAttachmentName(file);
  return `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isBlockedWoUploadName(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return WO_BLOCKED_EXTENSIONS.has(ext);
}

function makeWoStorageKey(woId, filename) {
  const ext = path.extname(filename || '').slice(0, 20);
  return `${woId}/${crypto.randomUUID()}${ext}`;
}

async function loadWorkOrderForFileUpload(req) {
  const { data: wo, error } = await supabase
    .from('work_orders')
    .select('id, assigned_to_user_id, assigned_to, work_order_assignees(user_id)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw error;
  return wo;
}

function directUploadError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function isAssignedToCurrentUser(req, wo) {
  if (!wo || req.session?.role !== 'worker') return true;
  const userId = Number(req.session.userId);
  const userName = req.res?.locals?.currentUser?.name || '';
  return Number(wo.assigned_to_user_id) === userId ||
    (wo.assignees || []).some(a => Number(a.id) === userId) ||
    (wo.work_order_assignees || []).some(a => Number(a.user_id || a.users?.id) === userId) ||
    (wo.assigned_to && userName && String(wo.assigned_to).includes(userName));
}

function workerForbidden(res, message = 'You can only access work orders assigned to you.') {
  return res.status(403).render('error', { title: 'Forbidden', code: 403, message });
}

function requireManagerRole(req, res) {
  if (req.session?.role === 'worker') {
    workerForbidden(res, 'Manager or admin access required.');
    return false;
  }
  return true;
}

function isMissingOptionalTableError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return code === '42P01' || code === 'PGRST205' || message.includes('does not exist');
}

function idInFilter(ids) {
  const cleanIds = Array.from(new Set(ids || []))
    .map(Number)
    .filter(Number.isInteger);
  return cleanIds.length ? `id.in.(${cleanIds.join(',')})` : null;
}

async function workOrderIdsAssignedToUser(userId) {
  const { data, error } = await supabase
    .from('work_order_assignees')
    .select('work_order_id')
    .eq('user_id', Number(userId));
  if (error) throw error;
  return (data || [])
    .map(a => Number(a.work_order_id))
    .filter(Number.isInteger);
}

function asArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input !== 'object') return [];
  return Object.keys(input).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map(k => input[k]);
}

function validateLineItem(li) {
  const description = emptyToNull(li.description);
  const unit = emptyToNull(li.unit) || 'ea';
  const quantity = parseFloat(li.quantity);
  const unitPrice = parseFloat(li.unit_price);
  const cost = parseFloat(li.cost);
  const completed = (li.completed === '1' || li.completed === 'on' || li.completed === true || li.completed === 1) ? 1 : 0;
  return {
    data: {
      description,
      quantity: isFinite(quantity) && quantity >= 0 ? quantity : 0,
      unit: VALID_UNITS.includes(unit) ? unit : 'ea',
      unit_price: isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      cost: isFinite(cost) && cost >= 0 ? cost : 0,
      completed,
    }
  };
}

function validateWorkOrder(body) {
  const errors = {};
  const status = emptyToNull(body.status) || 'open';
  if (!VALID_STATUSES.includes(status)) errors.status = 'Choose a valid status.';
  const scheduledDate = emptyToNull(body.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) errors.scheduled_date = 'Use YYYY-MM-DD.';
  const scheduledTime = emptyToNull(body.scheduled_time);
  if (scheduledTime && !/^\d{2}:\d{2}$/.test(scheduledTime)) errors.scheduled_time = 'Use HH:MM.';
  const scheduledEndTime = emptyToNull(body.scheduled_end_time);
  if (scheduledEndTime && !/^\d{2}:\d{2}$/.test(scheduledEndTime)) errors.scheduled_end_time = 'Use HH:MM.';

  const rawItems = asArray(body.lines);
  const items = [];
  rawItems.forEach((li) => {
    if (!emptyToNull(li.description)) return;
    items.push(validateLineItem(li).data);
  });

  // Optional editable display number override
  let mainOverride = null, subOverride = null;
  const numOverride = emptyToNull(body.display_number);
  if (numOverride) {
    const parsed = numbering.parseDisplay(numOverride);
    if (!parsed) errors.display_number = 'Use format 0001-0000';
    else { mainOverride = parsed.main; subOverride = parsed.sub; }
  }

  return {
    errors,
    data: {
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      scheduled_end_time: scheduledEndTime,
      status,
      description: emptyToNull(body.description) || '',
      unit_number: (body.unit_number || '').trim(),
      notes: emptyToNull(body.notes),
      display_number_override: numOverride ? { main: mainOverride, sub: subOverride } : null,
      lines: items,
    }
  };
}

/** Next root WO display number, reading + advancing company_settings counter. */
async function nextRootWoDisplay() {
  const { data: settings, error: sErr } = await supabase
    .from('company_settings')
    .select('next_wo_main_number')
    .eq('id', 1)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!settings) throw new Error('company_settings not initialized.');
  const main = settings.next_wo_main_number;
  const { error: uErr } = await supabase
    .from('company_settings')
    .update({ next_wo_main_number: main + 1 })
    .eq('id', 1);
  if (uErr) throw uErr;
  return { main, sub: 0, display: numbering.formatDisplay(main, 0) };
}

/** Read + advance company_settings counter (auto-increment on create). */
/** Load a single WO with joined job/customer/assignee/parent + line items. */
async function loadWorkOrder(id) {
  const { data: wo, error } = await supabase
    .from('work_orders')
    .select(`
      *,
      jobs!left(id, title, address, city, state, zip,
        customers!left(id, name, email, billing_email, phone, address, city, state, zip)),
      users!left(name),
      customers!left(id, name, email, billing_email, phone, address, city, state, zip),
      work_order_assignees(user_id, notified_at, users!work_order_assignees_user_id_fkey(id, name, email)),
      work_order_contractors(contractor_id, notified_at, contractors!work_order_contractors_contractor_id_fkey(id, name, email, phone, trade))
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!wo) return null;

  // Flatten nested joins to match view expectations
  const j = wo.jobs;
  const c = j ? j.customers : wo.customers;
  wo.project_id = j ? j.id : null;
  wo.job_title = j ? j.title : null;
  wo.job_address = j ? j.address : null;
  wo.job_city = j ? j.city : null;
  wo.job_state = j ? j.state : null;
  wo.job_zip = j ? j.zip : null;
  wo.customer_id = c ? c.id : wo.customer_id;
  wo.customer_name = c ? c.name : null;
  wo.customer_email = c ? c.email : null;
  wo.customer_billing_email = c ? c.billing_email : null;
  wo.customer_phone = c ? c.phone : null;
  wo.customer_address = c ? c.address : null;
  wo.customer_city = c ? c.city : null;
  wo.customer_state = c ? c.state : null;
  wo.customer_zip = c ? c.zip : null;
  wo.assigned_user_name = wo.users ? wo.users.name : null;
  wo.assignees = (wo.work_order_assignees || [])
    .map(a => ({
      id: a.user_id || a.users?.id,
      name: a.users?.name || '',
      email: a.users?.email || '',
      notified_at: a.notified_at || null,
    }))
    .filter(a => a.id);
  wo.contractor_assignees = (wo.work_order_contractors || [])
    .map(a => ({
      id: a.contractor_id || a.contractors?.id,
      name: a.contractors?.name || '',
      email: a.contractors?.email || '',
      phone: a.contractors?.phone || '',
      trade: a.contractors?.trade || '',
      notified_at: a.notified_at || null,
    }))
    .filter(a => a.id);
  delete wo.jobs;
  delete wo.users;
  delete wo.work_order_assignees;
  delete wo.work_order_contractors;

  // Parent display number (separate lookup — parent_wo_id is a self-FK)
  wo.parent_display_number = null;
  if (wo.parent_wo_id) {
    const { data: parent } = await supabase
      .from('work_orders')
      .select('display_number')
      .eq('id', wo.parent_wo_id)
      .maybeSingle();
    wo.parent_display_number = parent ? parent.display_number : null;
  }

  // Line items
  const { data: lines, error: liErr } = await supabase
    .from('work_order_line_items')
    .select('*')
    .eq('work_order_id', id)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (liErr) throw liErr;
  wo.lines = lines || [];

  return wo;
}

/** Build the line-rows payload expected by create/update RPCs. */
function buildLineRows(lines) {
  return lines.map((li, idx) => ({
    description: li.description,
    quantity: li.quantity,
    unit: li.unit,
    unit_price: li.unit_price,
    cost: li.cost,
    line_total: calc.lineTotal(li),
    completed: li.completed ? 1 : 0,
    sort_order: idx,
  }));
}

/** Normalize a POST body field that could be a single value or array into a proper array. */
function normalizeArr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function normalizeAssigneeIds(input) {
  return [...new Set(normalizeArr(input)
    .map(id => parseInt(id, 10))
    .filter(id => Number.isInteger(id) && id > 0))];
}

function normalizeContractorIds(input) {
  return [...new Set(normalizeArr(input)
    .map(id => parseInt(id, 10))
    .filter(id => Number.isInteger(id) && id > 0))];
}

function primaryAssigneeFields(assigneeIds, users = []) {
  const primaryId = assigneeIds[0] || null;
  const names = assigneeIds
    .map(id => (users || []).find(u => Number(u.id) === Number(id))?.name)
    .filter(Boolean);
  return {
    assigned_to_user_id: primaryId,
    assigned_to: names.length ? names.join(', ') : null,
  };
}

function assignmentText(assigneeIds, users = [], contractorIds = [], contractors = []) {
  const userNames = assigneeIds
    .map(id => (users || []).find(u => Number(u.id) === Number(id))?.name)
    .filter(Boolean);
  const contractorNames = contractorIds
    .map(id => (contractors || []).find(c => Number(c.id) === Number(id))?.name)
    .filter(Boolean);
  return [...userNames, ...contractorNames].join(', ') || null;
}

async function loadWorkOrderFormRefs() {
  const [
    { data: customers, error: customersError },
    { data: users, error: usersError },
    { data: contractors, error: contractorsError },
  ] = await Promise.all([
    supabase.from('customers').select('id, name, email, phone, address, city, state, zip').order('name'),
    supabase.from('users').select('id, name, email').eq('active', 1).order('name'),
    supabase.from('contractors').select('id, name, email, phone, trade').eq('active', true).order('name'),
  ]);
  if (customersError) throw customersError;
  if (usersError) throw usersError;
  if (contractorsError) throw contractorsError;
  return { customers: customers || [], users: users || [], contractors: contractors || [] };
}

async function buildWorkOrderPdfBuffer(woId) {
  if (!pdf) return null;
  try {
    const wo = await loadWorkOrder(woId);
    if (!wo) return null;
    const { data: company } = await supabase
      .from('company_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    return pdf.renderToBuffer(pdf.generateWorkOrderPDF, { ...wo, wo_number: `WO-${String(wo.display_number).replace(/^WO-/i, '')}` }, company || {});
  } catch (e) {
    console.warn('[work-orders] WO PDF attachment failed:', e.message);
    return null;
  }
}

async function saveAssigneesAndNotify({ workOrderId, assigneeIds, users = [], customer = {}, display, unitNumber, description, notes, scheduledDate, scheduledTime, assignedByUserId }) {
  if (!assigneeIds.length) return;

  const pdfBuffer = await buildWorkOrderPdfBuffer(workOrderId);
  const sendWoEmail = require('../services/email').sendWorkOrderAssignedEmail;

  for (const uid of assigneeIds) {
    const { error: insErr } = await supabase.from('work_order_assignees').insert({
      work_order_id: workOrderId,
      user_id: uid,
      assigned_at: new Date().toISOString(),
      assigned_by_user_id: assignedByUserId || null,
    });
    if (insErr) {
      console.warn('[work-orders] assignee insert failed for uid', uid, ':', insErr.message);
      continue;
    }

    const assignee = (users || []).find(u => Number(u.id) === Number(uid));
    if (!assignee || !assignee.email) continue;

    try {
      await sendWoEmail({
        to: assignee.email,
        toName: assignee.name,
        woNumber: 'WO-' + display,
        woId: workOrderId,
        customerName: customer?.name || '',
        address: [customer?.address, customer?.city, customer?.state].filter(Boolean).join(', '),
        unitNumber: unitNumber || '',
        description: description || '',
        internalNotes: notes || '',
        scheduledDate: scheduledDate || '',
        scheduledTime: scheduledTime || '',
        pdfBuffer,
      });
      const { error: notifiedErr } = await supabase
        .from('work_order_assignees')
        .update({ notified_at: new Date().toISOString() })
        .eq('work_order_id', workOrderId)
        .eq('user_id', uid);
      if (notifiedErr) {
        console.warn('[work-orders] assignee notified_at update failed for uid', uid, ':', notifiedErr.message);
      }
    } catch (e) {
      console.warn('[work-orders] assignee email failed for', assignee.email, ':', e.message);
    }
  }
}

async function saveContractorsAndNotify({ workOrderId, contractorIds, contractors = [], customer = {}, display, unitNumber, description, notes, scheduledDate, scheduledTime, assignedByUserId }) {
  if (!contractorIds.length) return;

  const pdfBuffer = await buildWorkOrderPdfBuffer(workOrderId);
  const sendWoEmail = require('../services/email').sendWorkOrderAssignedEmail;

  for (const contractorId of contractorIds) {
    const { error: insErr } = await supabase.from('work_order_contractors').insert({
      work_order_id: workOrderId,
      contractor_id: contractorId,
      assigned_at: new Date().toISOString(),
      assigned_by_user_id: assignedByUserId || null,
    });
    if (insErr) {
      console.warn('[work-orders] contractor assignee insert failed for contractor', contractorId, ':', insErr.message);
      continue;
    }

    const contractor = (contractors || []).find(c => Number(c.id) === Number(contractorId));
    if (!contractor || !contractor.email) continue;

    try {
      await sendWoEmail({
        to: contractor.email,
        toName: contractor.name,
        woNumber: 'WO-' + display,
        woId: workOrderId,
        customerName: customer?.name || '',
        address: [customer?.address, customer?.city, customer?.state].filter(Boolean).join(', '),
        unitNumber: unitNumber || '',
        description: description || '',
        internalNotes: notes || '',
        scheduledDate: scheduledDate || '',
        scheduledTime: scheduledTime || '',
        pdfBuffer,
      });
      const { error: notifiedErr } = await supabase
        .from('work_order_contractors')
        .update({ notified_at: new Date().toISOString() })
        .eq('work_order_id', workOrderId)
        .eq('contractor_id', contractorId);
      if (notifiedErr) {
        console.warn('[work-orders] contractor notified_at update failed for contractor', contractorId, ':', notifiedErr.message);
      }
    } catch (e) {
      console.warn('[work-orders] contractor assignment email failed for', contractor.email, ':', e.message);
    }
  }
}

async function sendWorkOrderToAssignedContractors(wo) {
  const contractorIds = normalizeContractorIds((wo.contractor_assignees || []).map(a => a.id));
  if (!contractorIds.length) return { sent: 0, skipped: true, reason: 'No contractors selected.' };

  const { data: contractors, error: contractorErr } = await supabase
    .from('contractors')
    .select('id, name, email')
    .in('id', contractorIds);
  if (contractorErr) throw contractorErr;

  const contractorsWithEmail = (contractors || []).filter(c => c.email);
  if (!contractorsWithEmail.length) return { sent: 0, skipped: true, reason: 'Assigned contractors do not have email addresses.' };

  const pdfBuffer = await buildWorkOrderPdfBuffer(wo.id);
  const sendWoEmail = require('../services/email').sendWorkOrderAssignedEmail;
  let sent = 0;

  for (const contractor of contractorsWithEmail) {
    await sendWoEmail({
      to: contractor.email,
      toName: contractor.name,
      woNumber: 'WO-' + wo.display_number,
      woId: wo.id,
      customerName: wo.customer_name || '',
      address: [wo.customer_address || wo.job_address, wo.customer_city || wo.job_city, wo.customer_state || wo.job_state].filter(Boolean).join(', '),
      unitNumber: wo.unit_number || '',
      description: wo.description || '',
      internalNotes: wo.notes || '',
      scheduledDate: wo.scheduled_date || '',
      scheduledTime: wo.scheduled_time || '',
      pdfBuffer,
    });
    sent++;
    const { error: notifiedErr } = await supabase
      .from('work_order_contractors')
      .update({ notified_at: new Date().toISOString() })
      .eq('work_order_id', wo.id)
      .eq('contractor_id', contractor.id);
    if (notifiedErr) throw notifiedErr;
  }

  return { sent, skipped: false };
}

async function sendWorkOrderToAssignedUsers(wo) {
  const assigneeIds = normalizeAssigneeIds([
    ...(wo.assignees || []).map(a => a.id),
    wo.assigned_to_user_id,
  ]);
  if (!assigneeIds.length) return { sent: 0, skipped: true, reason: 'No assignees selected.' };

  const { data: users, error: userErr } = await supabase
    .from('users')
    .select('id, name, email')
    .in('id', assigneeIds);
  if (userErr) throw userErr;

  const usersWithEmail = (users || []).filter(u => u.email);
  if (!usersWithEmail.length) return { sent: 0, skipped: true, reason: 'Assigned users do not have email addresses.' };

  const pdfBuffer = await buildWorkOrderPdfBuffer(wo.id);
  const sendWoEmail = require('../services/email').sendWorkOrderAssignedEmail;
  let sent = 0;

  for (const assignee of usersWithEmail) {
    await sendWoEmail({
      to: assignee.email,
      toName: assignee.name,
      woNumber: 'WO-' + wo.display_number,
      woId: wo.id,
      customerName: wo.customer_name || '',
      address: [wo.customer_address || wo.job_address, wo.customer_city || wo.job_city, wo.customer_state || wo.job_state].filter(Boolean).join(', '),
      unitNumber: wo.unit_number || '',
      description: wo.description || '',
      internalNotes: wo.notes || '',
      scheduledDate: wo.scheduled_date || '',
      scheduledTime: wo.scheduled_time || '',
      pdfBuffer,
    });
    sent++;
    const { error: notifiedErr } = await supabase
      .from('work_order_assignees')
      .update({ notified_at: new Date().toISOString() })
      .eq('work_order_id', wo.id)
      .eq('user_id', assignee.id);
    if (notifiedErr) throw notifiedErr;
  }

  return { sent, skipped: false };
}

async function sendWorkOrderToAllAssignees(wo) {
  const userResult = await sendWorkOrderToAssignedUsers(wo);
  const contractorResult = await sendWorkOrderToAssignedContractors(wo);
  const sent = (userResult.sent || 0) + (contractorResult.sent || 0);
  const reasons = [userResult, contractorResult].filter(r => r.skipped && r.reason).map(r => r.reason);
  return {
    sent,
    skipped: sent === 0,
    reason: reasons.join(' '),
  };
}

async function createWorkOrderWithLines(woData, lines, userId) {
  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .insert(woData)
    .select('id, display_number')
    .single();
  if (woErr) throw woErr;

  const lineRows = (lines || []).map(line => ({ ...line, work_order_id: wo.id }));
  if (lineRows.length) {
    const { error: lineErr } = await supabase.from('work_order_line_items').insert(lineRows);
    if (lineErr) throw lineErr;
  }

  try {
    await supabase.from('audit_logs').insert({
      entity_type: 'work_order',
      entity_id: wo.id,
      action: 'create',
      before_json: null,
      after_json: { ...woData, lines: lineRows.length },
      source: 'user',
      user_id: userId || null,
    });
  } catch (e) {
    console.warn('[work-orders] audit create failed:', e.message);
  }

  return wo.id;
}

// --- list ---

router.get('/', async (req, res) => {
  // F4: sanitize before interpolating into PostgREST .ilike()/.or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const status = (req.query.status || '').trim();
  const assigneeFilter = parseInt(req.query.assignee, 10) || null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let users = [];
  if (req.session.role !== 'worker') {
    const { data: userRows, error: userErr } = await supabase
      .from('users')
      .select('id, name')
      .in('role', ['admin', 'manager', 'worker'])
      .order('name', { ascending: true });
    if (userErr) throw userErr;
    users = userRows || [];
  }

  let query = supabase
    .from('work_orders')
    .select(`
      id, display_number, wo_number_main, wo_number_sub, parent_wo_id,
      status, scheduled_date, scheduled_time, scheduled_end_time, completed_date, created_at, unit_number, description,
      customer_id, customers!left(id, name, address, city, state),
      job_id, jobs!left(id, title, address, city, state, customers!left(id, name, address, city, state)),
      assigned_to_user_id, users!left(name),
      work_order_assignees(users!work_order_assignees_user_id_fkey(id, name)),
      work_order_contractors(contractors!work_order_contractors_contractor_id_fkey(id, name))
    `, { count: 'exact', head: false });

  if (q) {
    // PostgREST OR across nested tables is finicky; restrict to display_number.
    const like = `%${q}%`;
    query = query.ilike('display_number', like);
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }
  if (assigneeFilter && req.session.role !== 'worker') {
    const assignedIds = await workOrderIdsAssignedToUser(assigneeFilter);
    query = assignedIds.length ? query.in('id', assignedIds) : query.in('id', [-1]);
  }
  if (req.session.role === 'worker') {
    // F4: sanitize userName before interpolating into the .or() filter — even
    // though it's set by the admin (not the worker), a malformed name
    // (containing a `,` or `(`) would otherwise break the filter.
    const userName = sanitizePostgrestSearch(res.locals.currentUser?.name || '');
    const filters = [`assigned_to_user_id.eq.${req.session.userId}`];
    if (userName) filters.push(`assigned_to.ilike.%${userName}%`);
    const joinTableFilter = idInFilter(await workOrderIdsAssignedToUser(req.session.userId));
    if (joinTableFilter) filters.push(joinTableFilter);
    query = query.or(filters.join(','));
  }

  const { data: rows, count: total, error } = await query
    .order('wo_number_main', { ascending: false })
    .order('wo_number_sub', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;

  const workOrders = (rows || []).map(r => ({
    id: r.id,
    display_number: r.display_number,
    wo_number_main: r.wo_number_main,
    wo_number_sub: r.wo_number_sub,
    parent_wo_id: r.parent_wo_id,
    status: r.status,
    scheduled_date: r.scheduled_date,
    scheduled_time: r.scheduled_time,
    scheduled_end_time: r.scheduled_end_time,
    completed_date: r.completed_date,
    created_at: r.created_at,
    unit_number: r.unit_number,
    description: r.description,
    customer_id: r.customer_id || (r.jobs && r.jobs.customers ? r.jobs.customers.id : null),
    customer_name: r.customers?.name || (r.jobs && r.jobs.customers ? r.jobs.customers.name : null),
    project_id: r.job_id,
    project_title: r.jobs?.title || null,
    project_address: [r.jobs?.address, r.jobs?.city, r.jobs?.state].filter(Boolean).join(', '),
    customer_address: [r.customers?.address || r.jobs?.customers?.address, r.customers?.city || r.jobs?.customers?.city, r.customers?.state || r.jobs?.customers?.state].filter(Boolean).join(', '),
    assignees: (r.work_order_assignees || []).map(a => ({ id: a.users?.id, name: a.users?.name })).filter(a => a.id),
    contractor_assignees: (r.work_order_contractors || []).map(a => ({ id: a.contractors?.id, name: a.contractors?.name })).filter(a => a.id),
    assigned_name: r.users ? r.users.name : null,
    assigned_to: [
      ...(r.work_order_assignees || []).map(a => a.users?.name).filter(Boolean),
      ...(r.work_order_contractors || []).map(a => a.contractors?.name).filter(Boolean),
    ].join(', ') || (r.users ? r.users.name : null),
  }));

  res.render('work-orders/index', {
    title: 'Work Orders', activeNav: 'work-orders',
    workOrders, q, status, page, users, assigneeFilter,
    totalPages: Math.max(1, Math.ceil((total || 0) / PAGE_SIZE)),
    total: total || 0, statuses: VALID_STATUSES,
    watchTables: ['work_orders'],
  });
});

// --- new (must come before /:id) ---

router.get('/new', async (req, res) => {
  if (!requireManagerRole(req, res)) return;
  const presetProjectId = parseInt(req.query.project_id || req.query.job_id, 10) || null;

  const [
    { data: customers, error: customersError },
    { data: projects, error: projectsError },
    { data: users, error: usersError },
    { data: contractors, error: contractorsError },
    { data: settings, error: settingsError },
  ] = await Promise.all([
    supabase.from('customers').select('id, name, email, phone, address, city, state, zip').order('name'),
    supabase.from('jobs').select(`
      id, title, customer_id, address, city, state, zip,
      customers!left(id, name)
    `).neq('title', '').order('title'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
    supabase.from('contractors').select('id, name, email, phone, trade').eq('active', true).order('name'),
    supabase.from('company_settings').select('next_wo_main_number').eq('id', 1).maybeSingle(),
  ]);
  if (customersError) throw customersError;
  if (projectsError) throw projectsError;
  if (usersError) throw usersError;
  if (contractorsError) throw contractorsError;
  if (settingsError) throw settingsError;

  // Flatten customer name into each project
  const projectsWithCustomer = (projects || []).map(p => ({
    ...p,
    customer_name: p.customers?.name || '',
  }));
  const presetProject = presetProjectId
    ? projectsWithCustomer.find(p => Number(p.id) === presetProjectId)
    : null;
  const presetCustomerId = presetProject?.customer_id || '';
  const presetCustomerName = presetProject?.customer_name || '';

  // Read next number WITHOUT incrementing (just for display)
  const suggestedNumber = settings ? { display: numbering.formatDisplay(settings.next_wo_main_number, 0) } : { display: '' };
  res.render('work-orders/new', {
    title: 'New work order', activeNav: 'work-orders',
    wo: { id: null, display_number: '', unit_number: '', suggested_display_number: suggestedNumber.display,
          customer_id: presetCustomerId, project_id: presetProject?.id || '', scheduled_date: '', scheduled_time: '', notes: '', description: '',
          assignee_ids: [], contractor_ids: [], lines: [] },
    customers: customers || [], projects: projectsWithCustomer, users: users || [], contractors: contractors || [],
    customerName: presetCustomerName, errors: {}, units: VALID_UNITS,
  });
});

router.post('/', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  const customerId = parseInt(req.body.customer_id, 10);
  let customer = null;
  if (customerId) {
    const { data, error } = await supabase.from('customers').select('id, name, email, phone, address, city, state, zip').eq('id', customerId).maybeSingle();
    if (error) throw error;
    customer = data;
  }

  const projectId = parseInt(req.body.project_id, 10) || null;

  const { customers: allCustomers, users, contractors } = await loadWorkOrderFormRefs();

  const { errors, data } = validateWorkOrder(req.body);
  if (!customer) errors.customer_id = 'Customer is required.';

  if (Object.keys(errors).length) {
    // Reload projects for re-render
    const { data: projects, error: projectsError } = await supabase
      .from('jobs')
      .select('id, title, customer_id, address, city, state, zip, customers!left(id, name)')
      .neq('title', '').order('title');
    if (projectsError) throw projectsError;
    const projectsWithCustomer = (projects || []).map(p => ({ ...p, customer_name: p.customers?.name || '' }));

    return res.status(400).render('work-orders/new', {
      title: 'New work order', activeNav: 'work-orders',
      wo: { id: null, customer_id: customerId || '', project_id: projectId || '',
            status: data.status || 'open', unit_number: data.unit_number || '',
            display_number: req.body.display_number || '', suggested_display_number: '',
            scheduled_date: data.scheduled_date || '', scheduled_time: data.scheduled_time || '',
            notes: data.notes || '', description: data.description || '',
            assignee_ids: normalizeArr(req.body.assignee_ids), contractor_ids: normalizeArr(req.body.contractor_ids), lines: data.lines || [] },
      customers: allCustomers || [], projects: projectsWithCustomer, users: users || [], contractors: contractors || [],
      customerName: customer?.name || req.body.customer_search || '', errors, units: VALID_UNITS,
    });
  }

  // Resolve numbering
  let main, sub, display;
  if (data.display_number_override) {
    ({ main, sub } = data.display_number_override);
    display = numbering.formatDisplay(main, sub);
    const { data: dup, error: dupError } = await supabase.from('work_orders').select('id').eq('display_number', display).maybeSingle();
    if (dupError) throw dupError;
    if (dup) {
      errors.display_number = `WO ${display} already exists.`;
      return res.status(400).render('work-orders/new', {
        title: 'New work order', activeNav: 'work-orders',
        wo: { id: null, customer_id: customerId, project_id: projectId || '',
              status: data.status || 'open', unit_number: data.unit_number || '',
              display_number: req.body.display_number || '', suggested_display_number: '',
              scheduled_date: data.scheduled_date || '', scheduled_time: data.scheduled_time || '',
              notes: data.notes || '', description: data.description || '',
              assignee_ids: normalizeArr(req.body.assignee_ids), contractor_ids: normalizeArr(req.body.contractor_ids), lines: data.lines || [] },
        customers: allCustomers || [], projects: [], users: users || [], contractors: contractors || [],
        customerName: customer?.name || '', errors, units: VALID_UNITS,
      });
    }
  } else {
    const next = await nextRootWoDisplay();
    main = next.main; sub = next.sub; display = next.display;
  }

  const assigneeIds = normalizeAssigneeIds(req.body.assignee_ids);
  const contractorIds = normalizeContractorIds(req.body.contractor_ids);
  const assignmentFields = primaryAssigneeFields(assigneeIds, users || []);
  const assignedToText = assignmentText(assigneeIds, users || [], contractorIds, contractors || []);

  const newId = await createWorkOrderWithLines(
    {
      customer_id: customerId,
      unit_number: (req.body.unit_number || '').trim(),
      description: data.description || '',
      job_id: projectId,
      parent_wo_id: null,
      wo_number_main: main,
      wo_number_sub: sub,
      display_number: display,
      status: data.status,
      scheduled_date: data.scheduled_date,
      scheduled_time: data.scheduled_time,
      scheduled_end_time: null,
      assigned_to_user_id: assignmentFields.assigned_to_user_id,
      assigned_to: assignedToText,
      notes: data.notes || null,
    },
    buildLineRows(data.lines),
    req.session.userId || null
  );

  await saveAssigneesAndNotify({
    workOrderId: newId,
    assigneeIds,
    users: users || [],
    customer,
    display,
    unitNumber: req.body.unit_number || '',
    description: data.description || '',
    notes: data.notes || '',
    scheduledDate: data.scheduled_date || '',
    scheduledTime: data.scheduled_time || '',
    assignedByUserId: req.session.userId || null,
  });

  await saveContractorsAndNotify({
    workOrderId: newId,
    contractorIds,
    contractors: contractors || [],
    customer,
    display,
    unitNumber: req.body.unit_number || '',
    description: data.description || '',
    notes: data.notes || '',
    scheduledDate: data.scheduled_date || '',
    scheduledTime: data.scheduled_time || '',
    assignedByUserId: req.session.userId || null,
  });

  setFlash(req, 'success', `Work order WO-${display} created.`);
  res.redirect(`/work-orders/${newId}`);
});

// --- AI-assisted creation (must come before /:id) ---

router.get('/ai-create', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  res.render('work-orders/ai-create', {
    title: 'AI-assisted work order', activeNav: 'work-orders',
    text: '', error: null
  });
});

router.post('/ai-create', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  const text = (req.body.description || '').trim();
  if (!text || text.length < 20) {
    return res.render('work-orders/ai-create', {
      title: 'AI-assisted WO', activeNav: 'work-orders', text,
      error: 'Provide more detail (at least 20 characters).'
    });
  }
  const ai = require('../services/ai');
  if (!ai.isConfigured()) {
    return res.render('work-orders/ai-create', {
      title: 'AI-assisted WO', activeNav: 'work-orders', text,
      error: 'AI not configured. Add AI_API_KEY to .env.'
    });
  }
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name, email').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);

  try {
    const result = await ai.extractWorkOrder({
      text,
      customers: customers || [],
      users: users || [],
      userId: req.session.userId,
    });
    if (!result.ok) {
      return res.render('work-orders/ai-create', {
        title: 'AI-assisted WO', activeNav: 'work-orders', text,
        error: `AI parse failed: ${result.reason}`
      });
    }
    res.render('work-orders/ai-create-preview', {
      title: 'Review AI extraction', activeNav: 'work-orders',
      extracted: result.data,
      rawText: text,
      customers: customers || [], users: users || [],
      tokens: result.tokens,
    });
  } catch (err) {
    console.error('AI extraction error:', err);
    res.render('work-orders/ai-create', {
      title: 'AI-assisted WO', activeNav: 'work-orders', text,
      error: `AI error: ${err.message}`
    });
  }
});

router.post('/ai-finalize', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  const { customer_action, customer_name, customer_email, customer_id } = req.body;
  const jobTitle = (req.body.job_title || '').trim();
  const jobAddress = (req.body.job_address || '').trim();
  const jobCity = (req.body.job_city || '').trim();
  const jobState = (req.body.job_state || '').trim();
  const jobZip = (req.body.job_zip || '').trim();
  const jobDescription = (req.body.job_description || '').trim();
  const scheduledDate = (req.body.scheduled_date || '').trim() || null;
  const scheduledTime = (req.body.scheduled_time || '').trim() || null;
  const notes = (req.body.notes || '').trim() || null;
  const { data: users } = await supabase.from('users').select('id, name, email').eq('active', 1).order('name');

  if (!jobTitle) {
    setFlash(req, 'error', 'Work order title is required.');
    return res.redirect('/work-orders/ai-create');
  }

  // Resolve customer (existing or new)
  let resolvedCustomerId;
  if (customer_action === 'use_existing' && customer_id) {
    resolvedCustomerId = parseInt(customer_id, 10);
  } else {
    const name = (customer_name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Customer name is required for a new customer.');
      return res.redirect('/work-orders/ai-create');
    }
    const { data: newCust, error: cErr } = await supabase
      .from('customers')
      .insert({ name, email: customer_email || null })
      .select('id')
      .single();
    if (cErr) throw cErr;
    resolvedCustomerId = newCust.id;
  }

  // Create job
  const { data: newJob, error: jErr } = await supabase
    .from('jobs')
    .insert({
      customer_id: resolvedCustomerId,
      title: jobTitle,
      address: jobAddress || null,
      city: jobCity || null,
      state: jobState || null,
      zip: jobZip || null,
      description: jobDescription || null,
      status: 'estimating',
    })
    .select('id')
    .single();
  if (jErr) throw jErr;
  const jobId = newJob.id;

  // Assignees → primary user_id + comma-joined cache text
  const rawAssignees = asArray(req.body.assignees);
  const assigneeIds = [];
  const assignedToParts = [];
  for (const a of rawAssignees) {
    const uid = a.user_id ? parseInt(a.user_id, 10) : null;
    if (uid) assigneeIds.push(uid);
    else if (a.name) assignedToParts.push(a.name);
  }
  const uniqueAssigneeIds = [...new Set(assigneeIds)];
  const assignmentFields = primaryAssigneeFields(uniqueAssigneeIds, users || []);
  const assignedToText = [assignmentFields.assigned_to, ...assignedToParts].filter(Boolean).join(', ') || null;

  // Build line items
  const rawLines = asArray(req.body.lines);
  const lines = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const li = rawLines[idx];
    const desc = (li.description || '').trim();
    if (!desc) continue;
    const qty = parseFloat(li.quantity) || 0;
    const up = parseFloat(li.unit_price) || 0;
    lines.push({
      description: desc,
      quantity: qty,
      unit: li.unit || 'ea',
      unit_price: up,
      cost: 0,
      line_total: calc.lineTotal({ quantity: qty, unit_price: up }),
      completed: 0,
      sort_order: idx,
    });
  }

  // Resolve numbering (advance counter)
  const next = await nextRootWoDisplay();

  const newId = await createWorkOrderWithLines(
    {
      job_id: jobId,
      parent_wo_id: null,
      wo_number_main: next.main,
      wo_number_sub: next.sub,
      display_number: next.display,
      status: 'scheduled',
      description: jobDescription || jobTitle,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      scheduled_end_time: null,
      assigned_to_user_id: assignmentFields.assigned_to_user_id,
      assigned_to: assignedToText,
      notes,
    },
    lines,
    req.session.userId || null
  );

  const { data: customerForEmail } = await supabase
    .from('customers')
    .select('id, name, email, phone, address, city, state, zip')
    .eq('id', resolvedCustomerId)
    .maybeSingle();

  await saveAssigneesAndNotify({
    workOrderId: newId,
    assigneeIds: uniqueAssigneeIds,
    users: users || [],
    customer: customerForEmail || { name: customer_name || '' },
    display: next.display,
    unitNumber: '',
    description: jobDescription || jobTitle,
    notes: notes || '',
    scheduledDate: scheduledDate || '',
    scheduledTime: scheduledTime || '',
    assignedByUserId: req.session.userId || null,
  });

  setFlash(req, 'success', `WO-${next.display} created from AI extraction.`);
  res.redirect(`/work-orders/${newId}`);
});

// --- show ---

router.get('/:id', async (req, res) => {
  const wo = await loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (!isAssignedToCurrentUser(req, wo)) return workerForbidden(res);

  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, status')
    .eq('work_order_id', wo.id)
    .maybeSingle();

  let invoice = null;
  if (estimate) {
    const { data: inv } = await supabase
      .from('invoices')
      .select('id, status')
      .eq('estimate_id', estimate.id)
      .maybeSingle();
    invoice = inv || null;
  }

  // Notes feed (wo_notes + author name lookup)
  let notes = [];
  try {
    const { data: noteRows } = await supabase
      .from('wo_notes')
      .select('id, body, created_at, user_id')
      .eq('work_order_id', wo.id)
      .order('created_at', { ascending: true });
    notes = noteRows || [];
    // Resolve user names in a single batched query
    const userIds = Array.from(new Set(notes.map(n => n.user_id).filter(Boolean)));
    if (userIds.length) {
      const { data: noteUsers } = await supabase
        .from('users')
        .select('id, name')
        .in('id', userIds);
      const nameById = {};
      (noteUsers || []).forEach(u => { nameById[u.id] = u.name; });
      notes = notes.map(n => ({ ...n, user_name: nameById[n.user_id] || null }));
    }
  } catch (e) {
    // wo_notes may be missing on very old DBs
  }

  // Photos / files (attached to WO)
  let photos = [];
  try {
    const { data: photoRows } = await supabase
      .from('wo_photos')
      .select('id, work_order_id, user_id, filename, original_filename, mime_type, size_bytes, caption, created_at')
      .eq('work_order_id', wo.id)
      .order('created_at', { ascending: false });
    photos = photoRows || [];
    const userIds = Array.from(new Set(photos.map(p => p.user_id).filter(Boolean)));
    let nameById = {};
    if (userIds.length) {
      const { data: photoUsers } = await supabase
        .from('users')
        .select('id, name')
        .in('id', userIds);
      (photoUsers || []).forEach(u => { nameById[u.id] = u.name; });
    }
    photos = await Promise.all(photos.map(async (p) => {
      const mime = (p.mime_type || '').toLowerCase();
      const isImage = mime.startsWith('image/');
      let url = '#';
      try {
        url = await storage.getSignedUrl('wo-photos', p.filename, 3600);
      } catch (e) { console.warn('[wo-files] failed to resolve URL for', p.filename); }
      return { ...p, url, raw_url: `/work-orders/${wo.id}/files/${p.id}/raw`, is_image: isImage, user_name: nameById[p.user_id] || null };
    }));
  } catch (e) {
    // wo_photos may be missing on very old DBs
  }

  // File count: files attached via folders.entity_type/id
  let fileCount = 0;
  try {
    const { data: folder } = await supabase
      .from('folders')
      .select('id')
      .eq('entity_type', 'work_order')
      .eq('entity_id', wo.id)
      .maybeSingle();
    if (folder) {
      const { count } = await supabase
        .from('files')
        .select('id', { count: 'exact', head: true })
        .eq('folder_id', folder.id);
      fileCount = count || 0;
    }
  } catch (e) { /* best-effort */ }

  // F-010: vendor bills linked to this WO
  let bills = [];
  try {
    const { data: billData } = await supabase
      .from('bills')
      .select('id, bill_number, total, status, bill_date, due_date, vendors!left(name)')
      .eq('work_order_id', wo.id)
      .order('bill_date', { ascending: false });
    bills = (billData || []).map(function(b) {
      return { ...b, vendor_name: b.vendors?.name || '—' };
    });
  } catch (e) { /* best-effort */ }

  const activity = await listEntityActivity({
    workOrderId: wo.id,
    estimateId: estimate?.id,
    invoiceId: invoice?.id,
  });

  res.render('work-orders/show', {
    title: `WO-${wo.display_number}`, activeNav: 'work-orders',
    wo, estimate, invoice, notes, photos, fileCount, bills, activity
  });
});

// --- edit / update ---

router.get('/:id/edit', async (req, res) => {
  const wo = await loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (!isAssignedToCurrentUser(req, wo)) return workerForbidden(res);
  if (['closed', 'complete', 'cancelled'].includes(wo.status)) {
    setFlash(req, 'error', `WO-${wo.display_number} is "${wo.status}" and cannot be edited.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }
  const { data: users } = await supabase
    .from('users')
    .select('id, name')
    .eq('active', 1)
    .order('name');
  const { data: contractors } = await supabase
    .from('contractors')
    .select('id, name, email, phone, trade')
    .eq('active', true)
    .order('name');
  const { data: customers } = await supabase
    .from('customers')
    .select('id, name, email, phone, address, city, state, zip')
    .order('name');
  const { data: projects } = await supabase
    .from('jobs')
    .select('id, title, customer_id, address, city, state, zip, customers!left(id, name)')
    .neq('title', '').order('title');
  const projectsWithCustomer = (projects || []).map(p => ({ ...p, customer_name: p.customers?.name || '' }));

  res.render('work-orders/edit', {
    title: `Edit WO-${wo.display_number}`, activeNav: 'work-orders',
    wo: {
      ...wo,
      project_id: wo.job_id,
      assignee_ids: (wo.assignees || []).map(a => a.id).filter(Boolean),
      contractor_ids: (wo.contractor_assignees || []).map(a => a.id).filter(Boolean),
    },
    customers: customers || [], projects: projectsWithCustomer, users: users || [], contractors: contractors || [], errors: {}, units: VALID_UNITS
  });
});

router.post('/:id', async (req, res) => {
  const existing = await loadWorkOrder(req.params.id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (!isAssignedToCurrentUser(req, existing)) return workerForbidden(res);
  if (['closed', 'complete', 'cancelled'].includes(existing.status)) {
    setFlash(req, 'error', `WO-${existing.display_number} is "${existing.status}" and cannot be edited.`);
    return res.redirect(`/work-orders/${existing.id}`);
  }

  const { errors, data } = validateWorkOrder(req.body);

  // Display-number override validation for legacy child work orders.
  let newDisplay = existing.display_number;
  let newMain = existing.wo_number_main;
  let newSub = existing.wo_number_sub;
  if (data.display_number_override) {
    const { main, sub } = data.display_number_override;
    if (existing.parent_wo_id && main !== existing.wo_number_main) {
      errors.display_number = 'Child work order main number must match parent.';
    } else {
      const candidate = numbering.formatDisplay(main, sub);
      if (candidate !== existing.display_number) {
        const { data: dup } = await supabase
          .from('work_orders')
          .select('id')
          .eq('display_number', candidate)
          .neq('id', existing.id)
          .maybeSingle();
        if (dup) errors.display_number = `WO ${candidate} already exists.`;
        else { newDisplay = candidate; newMain = main; newSub = sub; }
      }
    }
  }

  if (Object.keys(errors).length) {
    const { data: users } = await supabase
      .from('users')
      .select('id, name')
      .eq('active', 1)
      .order('name');
    const { data: contractors } = await supabase
      .from('contractors')
      .select('id, name, email, phone, trade')
      .eq('active', true)
      .order('name');

    return res.status(400).render('work-orders/edit', {
      title: `Edit WO-${existing.display_number}`, activeNav: 'work-orders',
      wo: {
        ...existing, ...data,
        assignee_ids: normalizeAssigneeIds(req.body.assignee_ids).filter(Boolean),
        contractor_ids: normalizeContractorIds(req.body.contractor_ids).filter(Boolean),
        display_number: req.body.display_number || existing.display_number
      },
      customers: [], projects: [], users: users || [], contractors: contractors || [], errors, units: VALID_UNITS
    });
  }

  const linesForUpdate = req.body.lines === undefined ? (existing.lines || []) : data.lines;
  const { data: users } = await supabase
    .from('users')
    .select('id, name, email')
    .eq('active', 1)
    .order('name');
  const newAssigneeIds = normalizeAssigneeIds(req.body.assignee_ids);
  const newContractorIds = normalizeContractorIds(req.body.contractor_ids);
  const assignmentFields = primaryAssigneeFields(newAssigneeIds, users || []);
  const { data: contractors, error: contractorsErr } = await supabase
    .from('contractors')
    .select('id, name, email, phone, trade')
    .in('id', newContractorIds.length ? newContractorIds : [-1]);
  if (contractorsErr) throw contractorsErr;
  const assignedToText = assignmentText(newAssigneeIds, users || [], newContractorIds, contractors || []);
  const nextNotes = Object.prototype.hasOwnProperty.call(req.body, 'notes')
    ? data.notes
    : existing.notes;

  const newProjectId = parseInt(req.body.project_id, 10) || null;

  const { error: rpcErr } = await supabase.rpc('update_work_order_with_lines', {
    wo_id: parseInt(existing.id, 10),
    wo_data: {
      wo_number_main: newMain,
      wo_number_sub: newSub,
      display_number: newDisplay,
      unit_number: data.unit_number,
      scheduled_date: data.scheduled_date,
      scheduled_time: data.scheduled_time,
      scheduled_end_time: data.scheduled_end_time,
      description: data.description || '',
      assigned_to_user_id: assignmentFields.assigned_to_user_id,
      assigned_to: assignedToText,
      notes: nextNotes,
    },
    lines: buildLineRows(linesForUpdate),
    user_id: req.session.userId || null,
  });
  if (rpcErr) throw rpcErr;
  const { error: assignUpdateErr } = await supabase
    .from('work_orders')
    .update({
      unit_number: data.unit_number,
      description: data.description || '',
      status: data.status,
      assigned_to_user_id: assignmentFields.assigned_to_user_id,
      assigned_to: assignedToText,
      job_id: newProjectId,
    })
    .eq('id', existing.id);
  if (assignUpdateErr) throw assignUpdateErr;

  // Update work_order_assignees
  const { data: currentAssignees, error: currentAssigneesErr } = await supabase.from('work_order_assignees').select('user_id').eq('work_order_id', existing.id);
  if (currentAssigneesErr) throw currentAssigneesErr;
  const currentIds = (currentAssignees || []).map(a => Number(a.user_id)).filter(Boolean);
  const toAdd = newAssigneeIds.filter(id => !currentIds.includes(id));
  const toRemove = currentIds.filter(id => !newAssigneeIds.includes(id));
  for (const uid of toRemove) {
    const { error: removeAssigneeErr } = await supabase.from('work_order_assignees').delete().eq('work_order_id', existing.id).eq('user_id', uid);
    if (removeAssigneeErr) throw removeAssigneeErr;
    // Notify removed assignees (D-067e)
    const removedUser = (users || []).find(u => Number(u.id) === Number(uid));
    if (removedUser && removedUser.email) {
      const { sendWorkOrderUnassignedEmail } = require('../services/email');
      sendWorkOrderUnassignedEmail({
        to: removedUser.email,
        toName: removedUser.name,
        woNumber: `WO-${existing.display_number}`,
        woId: existing.id,
        customerName: existing.customer_name,
        unitNumber: existing.unit_number,
      }).catch(err => console.warn('[work-orders] unassign email failed for', removedUser.email, err.message));
    }
  }
  await saveAssigneesAndNotify({
    workOrderId: existing.id,
    assigneeIds: toAdd,
    users: users || [],
    customer: {
      name: existing.customer_name,
      address: existing.customer_address || existing.job_address,
      city: existing.customer_city || existing.job_city,
      state: existing.customer_state || existing.job_state,
    },
    display: newDisplay,
    unitNumber: existing.unit_number || '',
    description: data.description || existing.description || '',
    notes: nextNotes || '',
    scheduledDate: data.scheduled_date || '',
    scheduledTime: data.scheduled_time || '',
    assignedByUserId: req.session.userId || null,
  });

  // Update contractor assignees
  const { data: currentContractors, error: currentContractorsErr } = await supabase
    .from('work_order_contractors')
    .select('contractor_id')
    .eq('work_order_id', existing.id);
  if (currentContractorsErr) throw currentContractorsErr;
  const currentContractorIds = (currentContractors || []).map(a => Number(a.contractor_id)).filter(Boolean);
  const contractorsToAdd = newContractorIds.filter(id => !currentContractorIds.includes(id));
  const contractorsToRemove = currentContractorIds.filter(id => !newContractorIds.includes(id));
  for (const contractorId of contractorsToRemove) {
    const { error: removeContractorErr } = await supabase
      .from('work_order_contractors')
      .delete()
      .eq('work_order_id', existing.id)
      .eq('contractor_id', contractorId);
    if (removeContractorErr) throw removeContractorErr;
  }
  await saveContractorsAndNotify({
    workOrderId: existing.id,
    contractorIds: contractorsToAdd,
    contractors: contractors || [],
    customer: {
      name: existing.customer_name,
      address: existing.customer_address || existing.job_address,
      city: existing.customer_city || existing.job_city,
      state: existing.customer_state || existing.job_state,
    },
    display: newDisplay,
    unitNumber: existing.unit_number || '',
    description: data.description || existing.description || '',
    notes: nextNotes || '',
    scheduledDate: data.scheduled_date || '',
    scheduledTime: data.scheduled_time || '',
    assignedByUserId: req.session.userId || null,
  });

  setFlash(req, 'success', `WO-${newDisplay} updated.`);
  res.redirect(`/work-orders/${existing.id}`);
});

router.post('/:id/send', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  const wo = await loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });

  try {
    const result = await sendWorkOrderToAllAssignees(wo);
    if (result.skipped) {
      setFlash(req, 'error', result.reason || `WO-${wo.display_number} was not sent.`);
    } else {
      setFlash(req, 'success', `WO-${wo.display_number} sent to ${result.sent} assigned ${result.sent === 1 ? 'person' : 'people'}.`);
    }
  } catch (err) {
    console.error('[work-orders] manual send failed:', err);
    setFlash(req, 'error', `Could not send WO-${wo.display_number}: ${err.message}`);
  }

  res.redirect(`/work-orders/${wo.id}`);
});

// --- status transitions (RPC handles status field, timestamps, audit) ---

function statusTransitionRoute(newStatus, friendlyVerb) {
  return async (req, res) => {
    const { data: wo, error } = await supabase
      .from('work_orders')
      .select('id, display_number, status, assigned_to_user_id, assigned_to, work_order_assignees(user_id)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
    if (!isAssignedToCurrentUser(req, wo)) return workerForbidden(res);

    const { error: rpcErr } = await supabase.rpc('transition_work_order_status', {
      wo_id: parseInt(wo.id, 10),
      new_status: newStatus,
      user_id: req.session.userId || null,
    });
    if (rpcErr) {
      // The RPC enforces transition legality; surface its message verbatim.
      setFlash(req, 'error', `Cannot ${friendlyVerb} WO-${wo.display_number}: ${rpcErr.message}`);
      return res.redirect(`/work-orders/${wo.id}`);
    }

    setFlash(req, 'success', `WO-${wo.display_number} marked ${newStatus.replace('_', ' ')}.`);
    res.redirect(`/work-orders/${wo.id}`);
  };
}

router.post('/:id/start',    statusTransitionRoute('in_progress', 'start'));
router.post('/:id/complete', statusTransitionRoute('complete',    'complete'));
router.post('/:id/cancel',   statusTransitionRoute('cancelled',   'cancel'));

// --- notes ---

router.post('/:id/notes', async (req, res) => {
  const { data: wo, error: findErr } = await supabase
    .from('work_orders')
    .select('id, assigned_to_user_id, assigned_to, work_order_assignees(user_id)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!wo) {
    setFlash(req, 'error', 'Work order not found.');
    return res.redirect('/work-orders');
  }

  if (!isAssignedToCurrentUser(req, wo)) {
    setFlash(req, 'error', 'You can only post notes on work orders assigned to you.');
    return res.redirect(`/work-orders/${wo.id}`);
  }

  const body = (req.body.body || '').trim();
  if (!body || body.length < 2) {
    setFlash(req, 'error', 'Note must be at least 2 characters.');
    return res.redirect(`/work-orders/${wo.id}`);
  }

  const { error: insErr } = await supabase
    .from('wo_notes')
    .insert({ work_order_id: wo.id, user_id: req.session.userId, body });
  if (insErr) throw insErr;

  // Audit (best-effort)
  try {
    await supabase.from('audit_logs').insert({
      entity_type: 'work_order', entity_id: wo.id, action: 'note_added',
      before_json: null, after_json: { body },
      source: 'user', user_id: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', 'Note posted.');
  res.redirect(`/work-orders/${wo.id}`);
});

// --- files: upload ---

router.post('/:id/files', async (req, res) => {
  const wo = await loadWorkOrderForFileUpload(req);
  if (!wo) {
    setFlash(req, 'error', 'Work order not found.');
    return res.redirect('/work-orders');
  }
  if (!isAssignedToCurrentUser(req, wo)) {
    setFlash(req, 'error', 'You can only upload files to assigned WOs.');
    return res.redirect(`/work-orders/${wo.id}`);
  }

  woUpload.array('files', MAX_FILES)(req, res, async (err) => {
    if (err) {
      setFlash(req, 'error', err.message);
      return res.redirect(`/work-orders/${wo.id}`);
    }
    const files = req.files || [];
    if (files.length === 0) {
      setFlash(req, 'error', 'No files selected.');
      return res.redirect(`/work-orders/${wo.id}`);
    }
    const caption = (req.body.caption || '').trim();

    const uploadedKeys = [];
    try {
      for (const f of files) {
        const key = makeWoStorageKey(wo.id, f.originalname);
        await storage.uploadBuffer('wo-photos', key, f.buffer, f.mimetype);
        uploadedKeys.push(key);
        const { error: insErr } = await supabase
          .from('wo_photos')
          .insert({
            work_order_id: wo.id,
            user_id: req.session.userId,
            filename: key,
            original_filename: f.originalname,
            mime_type: f.mimetype,
            size_bytes: f.size,
            caption: caption || null,
          });
        if (insErr) throw insErr;
      }

      // Single audit row for the batch
      try {
        await supabase.from('audit_logs').insert({
          entity_type: 'work_order', entity_id: wo.id, action: 'file_uploaded',
          before_json: null,
          after_json: { count: files.length, filenames: uploadedKeys },
          source: 'user', user_id: req.session.userId,
        });
      } catch (e) { /* best-effort */ }
    } catch (e) {
      console.error('file upload failed:', e);
      // Best-effort cleanup of any Storage uploads
      for (const k of uploadedKeys) {
        try { await storage.remove('wo-photos', k); } catch (_) {}
      }
      setFlash(req, 'error', 'Failed to save files: ' + e.message);
      return res.redirect(`/work-orders/${wo.id}`);
    }

    const msg = files.length === 1 ? '1 file uploaded.' : `${files.length} files uploaded.`;
    setFlash(req, 'success', msg);
    res.redirect(`/work-orders/${wo.id}`);
  });
});

router.get('/:id/files/upload-url', async (req, res) => {
  const wo = await loadWorkOrderForFileUpload(req);
  if (!wo) return directUploadError(res, 404, 'Work order not found.');
  if (!isAssignedToCurrentUser(req, wo)) return directUploadError(res, 403, 'You can only upload files to assigned WOs.');

  const filename = String(req.query.filename || '').trim();
  const size = Number(req.query.size || 0);
  const contentType = String(req.query.content_type || 'application/octet-stream').trim();
  if (!filename) return directUploadError(res, 400, 'Filename is required.');
  if (isBlockedWoUploadName(filename)) return directUploadError(res, 400, 'File type not allowed.');
  if (!Number.isFinite(size) || size <= 0) return directUploadError(res, 400, 'File size is required.');
  if (size > MAX_SIZE) return directUploadError(res, 413, `Each file must be ${Math.round(MAX_SIZE / 1024 / 1024)} MB or smaller.`);

  try {
    const key = makeWoStorageKey(wo.id, filename);
    const signed = await storage.getUploadUrl('wo-photos', key);
    return res.json({
      ok: true,
      uploadUrl: signed.uploadUrl,
      storageKey: signed.storageKey,
      contentType,
      maxFileSize: MAX_SIZE,
      maxFiles: MAX_DIRECT_FILES,
    });
  } catch (e) {
    console.error('work order direct upload URL failed:', e);
    return directUploadError(res, 500, 'Could not prepare upload: ' + e.message);
  }
});

router.post('/:id/files/register-direct', async (req, res) => {
  const wo = await loadWorkOrderForFileUpload(req);
  if (!wo) return directUploadError(res, 404, 'Work order not found.');
  if (!isAssignedToCurrentUser(req, wo)) return directUploadError(res, 403, 'You can only upload files to assigned WOs.');

  const files = Array.isArray(req.body.files) ? req.body.files : [];
  const caption = String(req.body.caption || '').trim().slice(0, 200);
  if (!files.length) return directUploadError(res, 400, 'No uploaded files to register.');
  if (files.length > MAX_DIRECT_FILES) return directUploadError(res, 400, `Select ${MAX_DIRECT_FILES} files or fewer per batch.`);

  const records = [];
  for (const file of files) {
    const storageKey = String(file.storage_key || file.storageKey || '').trim();
    const originalName = String(file.original_filename || file.originalName || '').trim();
    const mimeType = String(file.mime_type || file.mimeType || 'application/octet-stream').trim();
    const sizeBytes = Number(file.size_bytes || file.sizeBytes || 0);

    if (!storageKey || !storageKey.startsWith(`${wo.id}/`) || storageKey.includes('..')) {
      return directUploadError(res, 400, 'Invalid uploaded file key.');
    }
    if (!originalName || isBlockedWoUploadName(originalName)) {
      return directUploadError(res, 400, 'Invalid uploaded filename.');
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_SIZE) {
      return directUploadError(res, 400, 'Invalid uploaded file size.');
    }

    records.push({
      work_order_id: wo.id,
      user_id: req.session.userId,
      filename: storageKey,
      original_filename: originalName,
      mime_type: mimeType,
      size_bytes: Math.round(sizeBytes),
      caption: caption || null,
    });
  }

  try {
    const { data, error } = await supabase
      .from('wo_photos')
      .insert(records)
      .select('id, filename, original_filename');
    if (error) throw error;

    try {
      await supabase.from('audit_logs').insert({
        entity_type: 'work_order', entity_id: wo.id, action: 'file_uploaded',
        before_json: null,
        after_json: { count: records.length, filenames: records.map(r => r.filename) },
        source: 'user', user_id: req.session.userId,
      });
    } catch (e) { /* best-effort */ }

    return res.json({ ok: true, count: records.length, files: data || [] });
  } catch (e) {
    console.error('work order direct upload registration failed:', e);
    for (const record of records) {
      try { await storage.remove('wo-photos', record.filename); } catch (_) {}
    }
    return directUploadError(res, 500, 'Failed to save uploaded files: ' + e.message);
  }
});

// --- files: raw/open original ---

router.get('/:id/files/:fileId/raw', async (req, res) => {
  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .select('id, assigned_to_user_id, assigned_to, work_order_assignees(user_id)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (woErr) throw woErr;
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (!isAssignedToCurrentUser(req, wo)) return workerForbidden(res);

  const { data: file, error: fileErr } = await supabase
    .from('wo_photos')
    .select('*')
    .eq('id', req.params.fileId)
    .eq('work_order_id', wo.id)
    .maybeSingle();
  if (fileErr) throw fileErr;
  if (!file) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'File not found.' });

  try {
    const buffer = await storage.downloadBuffer('wo-photos', file.filename);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition('inline', file));
    return res.send(buffer);
  } catch (e) {
    return res.status(500).render('error', { title: 'Storage error', code: 500, message: 'Failed to access file: ' + e.message });
  }
});

// --- files: delete ---

router.post('/:id/files/:fileId/delete', async (req, res) => {
  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (woErr) throw woErr;
  if (!wo) {
    setFlash(req, 'error', 'Work order not found.');
    return res.redirect('/work-orders');
  }

  const { data: file, error: phErr } = await supabase
    .from('wo_photos')
    .select('*')
    .eq('id', req.params.fileId)
    .eq('work_order_id', wo.id)
    .maybeSingle();
  if (phErr) throw phErr;
  if (!file) {
    setFlash(req, 'error', 'File not found.');
    return res.redirect(`/work-orders/${wo.id}`);
  }

  // Permission: uploader or manager+
  const isOwner = file.user_id === req.session.userId;
  const isManager = req.session.role !== 'worker';
  if (!isOwner && !isManager) {
    setFlash(req, 'error', 'You can only delete your own files.');
    return res.redirect(`/work-orders/${wo.id}`);
  }

  // Best-effort Storage removal
  try { await storage.remove('wo-photos', file.filename); } catch (e) { /* best-effort */ }

  const { error: delErr } = await supabase.from('wo_photos').delete().eq('id', file.id);
  if (delErr) throw delErr;

  try {
    await supabase.from('audit_logs').insert({
      entity_type: 'work_order', entity_id: wo.id, action: 'file_deleted',
      before_json: { filename: file.filename, caption: file.caption },
      after_json: null,
      source: 'user', user_id: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', 'File deleted.');
  res.redirect(`/work-orders/${wo.id}`);
});

// --- PDF ---

router.get('/:id/pdf', async (req, res) => {
  const wo = await loadWorkOrder(req.params.id);
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });
  if (!isAssignedToCurrentUser(req, wo)) return workerForbidden(res);

  const { data: company } = await supabase
    .from('company_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  const filename = `WO-${wo.display_number}.pdf`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  if (!pdf) {
    if (!res.headersSent) {
      return res.status(500).render('error', { title: 'PDF error', code: 500, message: 'PDF service not available.' });
    }
    return res.end();
  }

  try {
    pdf.generateWorkOrderPDF({ ...wo, wo_number: `WO-${String(wo.display_number).replace(/^WO-/i, '')}` }, company || {}, res);
  } catch (err) {
    console.error('WO PDF failed:', err);
    if (!res.headersSent) res.status(500).render('error', { title: 'PDF error', code: 500, message: err.message });
    else res.end();
  }
});

// --- delete ---

router.post('/:id/delete', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  const id = parseInt(req.params.id, 10);
  const { data: wo, error: findErr } = await supabase
    .from('work_orders')
    .select('id, display_number, status')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });

  // Block deleting legacy parent records that still have child work orders.
  const { count: subCount, error: subErr } = await supabase
    .from('work_orders')
    .select('id', { count: 'exact', head: true })
    .eq('parent_wo_id', wo.id);
  if (subErr) throw subErr;
  if ((subCount || 0) > 0) {
    setFlash(req, 'error', `Cannot delete WO-${wo.display_number} — ${subCount} child work order(s) attached.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }

  // Block: estimates
  const { count: estCount, error: estErr } = await supabase
    .from('estimates')
    .select('id', { count: 'exact', head: true })
    .eq('work_order_id', wo.id);
  if (estErr) throw estErr;
  if ((estCount || 0) > 0) {
    setFlash(req, 'error', `Cannot delete WO-${wo.display_number} — an estimate references it.`);
    return res.redirect(`/work-orders/${wo.id}`);
  }

  // Cascade rows that don't have ON DELETE CASCADE
  const { error: lineDeleteErr } = await supabase.from('work_order_line_items').delete().eq('work_order_id', wo.id);
  if (lineDeleteErr) throw lineDeleteErr;
  // Notes + photos best-effort (table may not exist on older DBs)
  const { error: notesDeleteErr } = await supabase.from('wo_notes').delete().eq('work_order_id', wo.id);
  if (notesDeleteErr && !isMissingOptionalTableError(notesDeleteErr)) throw notesDeleteErr;
  const { error: photosDeleteErr } = await supabase.from('wo_photos').delete().eq('work_order_id', wo.id);
  if (photosDeleteErr && !isMissingOptionalTableError(photosDeleteErr)) throw photosDeleteErr;

  const { error: delErr } = await supabase.from('work_orders').delete().eq('id', wo.id);
  if (delErr) throw delErr;

  try {
    await supabase.from('audit_logs').insert({
      entity_type: 'work_order', entity_id: wo.id, action: 'delete',
      before_json: { display_number: wo.display_number, status: wo.status },
      after_json: null,
      source: 'user', user_id: req.session.userId,
    });
  } catch (e) { /* best-effort */ }

  setFlash(req, 'success', `WO-${wo.display_number} deleted.`);
  res.redirect('/work-orders');
});

// --- create estimate from WO (1:1) ---

router.post('/:id/create-estimate', async (req, res) => {
  if (!requireManagerRole(req, res)) return;

  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .select('*, work_order_line_items(*)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (woErr) throw woErr;
  if (!wo) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Work order not found.' });

  const { data: existing } = await supabase
    .from('estimates')
    .select('id')
    .eq('work_order_id', wo.id)
    .maybeSingle();
  if (existing) {
    setFlash(req, 'info', `Estimate already exists for WO-${wo.display_number}.`);
    return res.redirect(`/estimates/${existing.id}`);
  }

  const lines = (wo.work_order_line_items || []).slice().sort((a, b) => {
    const ao = a.sort_order || 0, bo = b.sort_order || 0;
    if (ao !== bo) return ao - bo;
    return (a.id || 0) - (b.id || 0);
  });

  const { data: settings } = await supabase
    .from('company_settings')
    .select('default_tax_rate, default_payment_terms')
    .eq('id', 1)
    .maybeSingle();
  const taxRate = Number(settings && settings.default_tax_rate) || 0;
  const totals = calc.totals(lines, taxRate);
  const costTotal = lines.reduce((s, li) =>
    s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);

  const linePayload = lines.map((li, idx) => ({
    description: li.description,
    quantity: li.quantity,
    unit: li.unit,
    unit_price: li.unit_price,
    cost: li.cost,
    line_total: calc.lineTotal(li),
    selected: 1,
    sort_order: idx,
  }));

  const { data: newId, error: rpcErr } = await supabase.rpc('create_estimate_with_lines', {
    estimate_data: {
      work_order_id: wo.id,
      status: 'draft',
      subtotal: totals.subtotal,
      tax_rate: taxRate,
      tax_amount: totals.taxAmount,
      total: totals.total,
      cost_total: costTotal,
    },
    lines: linePayload,
  });
  if (rpcErr) throw rpcErr;

  // Set valid_until to 30 days from now
  const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { error: validUntilErr } = await supabase.from('estimates').update({ valid_until: thirtyDays }).eq('id', newId);
  if (validUntilErr) throw validUntilErr;

  // D-125: copy unit_number from WO to the new estimate
  if (wo.unit_number) {
    const { error: unitErr } = await supabase.from('estimates').update({ unit_number: wo.unit_number }).eq('id', newId);
    if (unitErr) throw unitErr;
  }

  setFlash(req, 'success', `Estimate EST-${wo.display_number} created from WO-${wo.display_number}.`);
  res.redirect(`/estimates/${newId}/edit`);
});

module.exports = router;
