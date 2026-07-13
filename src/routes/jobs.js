/**
 * Jobs CRUD (v0.5).
 *
 * Adds: scheduled_date, scheduled_time, assigned_to_user_id.
 * GET /new: if ?customer_id=N is present, auto-prefills the site address
 * fields with the customer's address (overridable in the form).
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { getProjectContractorRollup } = require('../services/project-contractor-rollup');
const { renderSubcontractAgreementPdf } = require('../services/contract-pdf');
const { sendEmail } = require('../services/email');
const numbering = require('../services/numbering');
const storage = require('../services/storage');

const router = express.Router();
const PAGE_SIZE = 25;
const CHAT_PHOTO_BUCKET = 'entity-files';
const CHAT_PHOTO_MAX_SIZE = 10 * 1024 * 1024;
const chatPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_PHOTO_MAX_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (String(file.mimetype || '').startsWith('image/')) cb(null, true);
    else cb(new Error('Project chat attachments must be image files.'));
  }
});
// R37c: include RPM-native statuses so imported projects are filterable + creatable.
// DB CHECK on jobs.status was relaxed in migration r37b to accept these values.
const VALID_STATUSES = [
  'lead', 'estimating', 'scheduled', 'in_progress', 'complete', 'cancelled',
  'active', 'pending', 'pre-construction'
];

function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// R40: parse numeric helper for contract_value + total_paid
function emptyToNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? n : null;
}

function cleanDate(value) {
  const date = emptyToNull(value);
  if (!date) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function cleanTime(value) {
  const time = emptyToNull(value);
  if (!time) return null;
  return /^\d{2}:\d{2}$/.test(time) ? time : null;
}

function normalizeProjectScheduleStatus(value, hasDate) {
  const status = String(value || '').trim();
  if (['open', 'scheduled', 'in_progress', 'complete', 'cancelled'].includes(status)) return status;
  return hasDate ? 'scheduled' : 'open';
}

function formatScheduleTime(start, end) {
  if (!start && !end) return '-';
  return [start, end].filter(Boolean).join(' - ');
}

function throwIfSupabaseError(result, label) {
  if (result && result.error) {
    result.error.message = `${label}: ${result.error.message}`;
    throw result.error;
  }
  return result;
}

async function visibleProjectIdsForUser(userId) {
  const id = Number(userId);
  if (!id) return [];
  const [directResult, memberResult] = await Promise.all([
    supabase
      .from('jobs')
      .select('id')
      .or(`assigned_to_user_id.eq.${id},project_manager_user_id.eq.${id}`),
    supabase
      .from('job_members')
      .select('job_id')
      .eq('user_id', id),
  ]);
  throwIfSupabaseError(directResult, 'Project visibility direct load failed');
  throwIfSupabaseError(memberResult, 'Project visibility member load failed');
  return Array.from(new Set([
    ...(directResult.data || []).map(row => Number(row.id)),
    ...(memberResult.data || []).map(row => Number(row.job_id)),
  ].filter(Boolean)));
}

function applyProjectVisibility(query, visibleProjectIds) {
  return visibleProjectIds.length ? query.in('id', visibleProjectIds) : query.in('id', [-1]);
}

function hasAnyProjectAccess(access) {
  return !!(access && (access.canSeeBilling || access.canSeeOperations || access.canManageMembers));
}

function isMissingOptionalRfpTable(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    message.includes('project_rfps') ||
    message.includes('rfp_line_items') ||
    message.includes('could not find the table');
}

function vendorKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function encodeContractorKey(name) {
  return Buffer.from(String(name || ''), 'utf8').toString('base64url');
}

function decodeContractorKey(key) {
  try {
    return Buffer.from(String(key || ''), 'base64url').toString('utf8');
  } catch (e) {
    return decodeURIComponent(String(key || ''));
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeProjectChatFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const base = path.basename(filename || 'photo', ext)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'photo';
  return `${base}${ext || '.jpg'}`;
}

function projectChatPhotoKey(projectId, file) {
  return `project-chat/${projectId}/${Date.now()}-${crypto.randomUUID()}-${safeProjectChatFilename(file?.originalname)}`;
}

async function hydrateProjectChatAttachment(message) {
  if (!message || !message.attachment_key) return message;
  try {
    return {
      ...message,
      attachment_url: await storage.getSignedUrl(message.attachment_bucket || CHAT_PHOTO_BUCKET, message.attachment_key, 3600),
    };
  } catch (error) {
    console.warn('[project-chat] attachment signed URL failed:', error.message);
    return { ...message, attachment_url: null };
  }
}

function isMissingProjectChatReadsSchema(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    message.includes('project_chat_message_reads') ||
    message.includes('schema cache');
}

async function markProjectChatMessagesRead(messages, userId) {
  const readableIds = (messages || [])
    .filter(message => message?.id && Number(message.user_id) !== Number(userId))
    .map(message => Number(message.id));
  const messageIds = Array.from(new Set(readableIds));
  if (!messageIds.length || !userId) return;

  const now = new Date().toISOString();
  const rows = messageIds.map(messageId => ({
    message_id: messageId,
    user_id: Number(userId),
    seen_at: now,
  }));
  const { error } = await supabase
    .from('project_chat_message_reads')
    .upsert(rows, { onConflict: 'message_id,user_id' });
  if (error && !isMissingProjectChatReadsSchema(error)) {
    console.warn('[project-chat] read receipt update failed:', error.message);
  }
}

async function loadProjectChatReads(messageIds) {
  const ids = Array.from(new Set((messageIds || []).map(Number).filter(Boolean)));
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from('project_chat_message_reads')
    .select('message_id, user_id, seen_at, users!inner(id, name, email)')
    .in('message_id', ids)
    .order('seen_at', { ascending: true });
  if (error) {
    if (!isMissingProjectChatReadsSchema(error)) {
      console.warn('[project-chat] read receipt load failed:', error.message);
    }
    return {};
  }
  return (data || []).reduce((acc, read) => {
    const key = String(read.message_id);
    if (!acc[key]) acc[key] = [];
    acc[key].push({
      user_id: read.user_id,
      seen_at: read.seen_at,
      name: read.users?.name || read.users?.email || 'User',
      email: read.users?.email || '',
    });
    return acc;
  }, {});
}

function attachProjectChatReads(messages, readsByMessage) {
  return (messages || []).map(message => ({
    ...message,
    seen_by: (readsByMessage[String(message.id)] || [])
      .filter(read => Number(read.user_id) !== Number(message.user_id)),
  }));
}

function compactHandle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/^[-._]+|[-._]+$/g, '');
}

function firstNameHandle(name, email) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return compactHandle(first || String(email || '').split('@')[0]);
}

function fullNameHandle(name, email) {
  const fromName = compactHandle(String(name || '').trim().replace(/\s+/g, ''));
  return fromName || compactHandle(String(email || '').split('@')[0]);
}

function assignMentionHandles(users) {
  const normalized = (users || [])
    .filter(u => u && u.id && (u.name || u.email))
    .map(u => ({
      id: Number(u.id),
      name: u.name || u.email,
      email: u.email || '',
      firstHandle: firstNameHandle(u.name, u.email),
      fullHandle: fullNameHandle(u.name, u.email),
    }));
  const counts = normalized.reduce((acc, u) => {
    if (u.firstHandle) acc[u.firstHandle] = (acc[u.firstHandle] || 0) + 1;
    return acc;
  }, {});
  return normalized
    .map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      handle: counts[u.firstHandle] > 1 ? u.fullHandle : u.firstHandle,
    }))
    .filter(u => u.handle)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function addWorkOrderMentionUsers({ workOrders, users, add }) {
  const allUsers = users || [];
  (workOrders || []).forEach(wo => {
    const assigned = allUsers.find(u => Number(u.id) === Number(wo?.assigned_to_user_id));
    add(assigned);
    (wo.work_order_assignees || []).forEach(assignee => {
      add(assignee.users || assignee);
    });
  });
}

function buildChatMentionUsers({ members, users, projectManager, job, workOrders }) {
  const byId = new Map();
  function add(user) {
    if (!user || !user.id) return;
    const id = Number(user.id);
    if (!id || byId.has(id)) return;
    byId.set(id, {
      id,
      name: user.name || user.user_name || user.email || user.user_email || 'User',
      email: user.email || user.user_email || '',
    });
  }
  (members || []).forEach(m => add({ id: m.user_id, name: m.user_name, email: m.user_email }));
  add(projectManager);
  const assigned = (users || []).find(u => Number(u.id) === Number(job?.assigned_to_user_id));
  add(assigned);
  addWorkOrderMentionUsers({ workOrders, users, add });
  return assignMentionHandles(Array.from(byId.values()));
}

function mentionAliases(user) {
  return [
    user.handle,
    firstNameHandle(user.name, user.email),
    fullNameHandle(user.name, user.email),
    compactHandle(String(user.email || '').split('@')[0]),
  ].filter(Boolean);
}

function resolveMentionIds(message, mentionUsers, explicitIds) {
  const ids = new Set();
  (explicitIds || []).forEach(id => {
    const n = Number(id);
    if (n) ids.add(n);
  });

  const aliasBuckets = new Map();
  (mentionUsers || []).forEach(user => {
    mentionAliases(user).forEach(alias => {
      if (!aliasBuckets.has(alias)) aliasBuckets.set(alias, []);
      aliasBuckets.get(alias).push(Number(user.id));
    });
  });

  const matches = String(message || '').matchAll(/(^|\s)@([a-zA-Z0-9._-]+)/g);
  for (const match of matches) {
    const alias = compactHandle(match[2]);
    const bucket = aliasBuckets.get(alias) || [];
    if (bucket.length === 1) ids.add(bucket[0]);
  }
  return ids;
}

async function loadProjectMentionUsers(jobId) {
  const [jobResult, membersResult, usersResult, workOrdersResult] = await Promise.all([
    supabase.from('jobs').select('id, assigned_to_user_id, project_manager_user_id').eq('id', jobId).maybeSingle(),
    supabase.from('job_members').select('user_id, users!inner(id, name, email, active)').eq('job_id', jobId),
    supabase.from('users').select('id, name, email, active').eq('active', 1),
    supabase
      .from('work_orders')
      .select('assigned_to_user_id, work_order_assignees(users!work_order_assignees_user_id_fkey(id, name, email, active))')
      .eq('job_id', jobId),
  ]);
  throwIfSupabaseError(jobResult, 'Project mention job load failed');
  throwIfSupabaseError(membersResult, 'Project mention members load failed');
  throwIfSupabaseError(usersResult, 'Project mention users load failed');
  throwIfSupabaseError(workOrdersResult, 'Project mention work order assignees load failed');

  const job = jobResult.data || {};
  const allUsers = usersResult.data || [];
  const byId = new Map();
  function add(user) {
    if (!user || !user.id || user.active === 0 || user.active === false) return;
    byId.set(Number(user.id), { id: Number(user.id), name: user.name, email: user.email || '' });
  }
  (membersResult.data || []).forEach(m => add(m.users));
  [job.assigned_to_user_id, job.project_manager_user_id].forEach(id => {
    add(allUsers.find(u => Number(u.id) === Number(id)));
  });
  addWorkOrderMentionUsers({ workOrders: workOrdersResult.data || [], users: allUsers, add });
  return assignMentionHandles(Array.from(byId.values()));
}

async function sendProjectChatMentionEmails({ projectId, projectTitle, authorName, message, recipients }) {
  if (!recipients || !recipients.length) return;
  const base = process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app';
  const link = `${base}/projects/${projectId}`;
  const safeProject = escapeHtml(projectTitle || `Project #${projectId}`);
  const safeAuthor = escapeHtml(authorName || 'A FORGE user');
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const subject = `FORGE · You were mentioned on ${projectTitle || `Project #${projectId}`}`;

  const sends = recipients.map(recipient => sendEmail({
    to: recipient.email,
    subject,
    text: `${authorName || 'A FORGE user'} mentioned you in Project Chat for ${projectTitle || `Project #${projectId}`}:\n\n${message}\n\nOpen project: ${link}`,
    htmlBody: [
      `<p>Hi ${escapeHtml(recipient.name || '')},</p>`,
      `<p><strong>${safeAuthor}</strong> mentioned you in Project Chat for <strong>${safeProject}</strong>.</p>`,
      `<div style="background:#f7f7f7;border:1px solid #e5e5e5;border-radius:8px;padding:14px 16px;margin:16px 0;color:#222;font-size:14px;line-height:1.5">${safeMessage}</div>`,
      `<div style="text-align:center;margin:20px 0"><a href="${link}" style="display:inline-block;background:#c0202b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Open project chat</a></div>`,
    ].join('\n'),
  }));

  const results = await Promise.allSettled(sends);
  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      console.warn('[project-chat] mention email failed for', recipients[idx].email, result.reason?.message || result.reason);
    }
  });
}

function slugPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'contract';
}

function projectAddress(job) {
  return [job.address, [job.city, job.state, job.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

function withContractKeys(contractorRollup) {
  return (contractorRollup || []).map(c => ({ ...c, contract_key: encodeContractorKey(c.vendor) }));
}

async function loadContractData(projectId, contractorName) {
  const normalizedName = vendorKey(contractorName);
  if (!normalizedName) return null;

  const [
    jobResult,
    settingsResult,
    rfpResult,
    vendorsResult,
    contractorsResult,
  ] = await Promise.all([
    supabase
      .from('jobs')
      .select('*, customers!left(id, name, email, phone, address, city, state, zip)')
      .eq('id', projectId)
      .maybeSingle(),
    supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
    supabase.from('project_rfps').select('id, contractor_name, status').eq('job_id', projectId).eq('status', 'awarded'),
    supabase.from('vendors').select('*'),
    supabase.from('contractors').select('*'),
  ]);

  throwIfSupabaseError(jobResult, 'Contract project load failed');
  throwIfSupabaseError(settingsResult, 'Contract company settings load failed');
  throwIfSupabaseError(rfpResult, 'Contract RFP load failed');
  throwIfSupabaseError(vendorsResult, 'Contract vendor load failed');
  throwIfSupabaseError(contractorsResult, 'Contract contractor load failed');

  const job = jobResult.data;
  if (!job) return null;

  job.customer_name = job.customers?.name || job.client;
  job.project_manager_name = null;
  job.project_manager_email = null;
  if (job.project_manager_user_id) {
    const { data: manager, error: managerError } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', job.project_manager_user_id)
      .maybeSingle();
    if (managerError) throw managerError;
    job.project_manager_name = manager?.name || null;
    job.project_manager_email = manager?.email || null;
  }

  const rfps = rfpResult.data || [];
  const rfpIds = rfps.map(r => r.id);
  const rfpById = {};
  rfps.forEach(r => { rfpById[r.id] = r; });

  let items = [];
  if (rfpIds.length) {
    const { data: itemRows, error: itemError } = await supabase
      .from('rfp_line_items')
      .select('id, rfp_id, parent_line_item_id, vendor, description, quantity, unit_cost, total_cost, final_unit_cost, total_with_markup, approved, sort_order')
      .in('rfp_id', rfpIds)
      .eq('approved', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (itemError) throw itemError;
    items = (itemRows || [])
      .filter(item => vendorKey(item.vendor) === normalizedName)
      .map(item => ({
        ...item,
        category: rfpById[item.rfp_id]?.contractor_name || '',
        quantity: Number(item.quantity || 0),
        unit_cost: Number(item.unit_cost || 0),
        total_cost: Number(item.total_cost || 0),
        final_unit_cost: Number(item.final_unit_cost || item.unit_cost || 0),
        total_with_markup: Number(item.total_with_markup || 0),
      }));
  }

  const contractors = contractorsResult.data || [];
  const vendors = vendorsResult.data || [];
  const contractor = contractors.find(c => vendorKey(c.name) === normalizedName)
    || vendors.find(v => vendorKey(v.name) === normalizedName)
    || { name: contractorName };
  const contractTotal = items.reduce((sum, item) => sum + Number(item.total_cost || 0), 0);

  return {
    job,
    company: settingsResult.data || {},
    customer: job.customers || {},
    contractor,
    vendorName: contractorName,
    items,
    contractTotal,
  };
}

async function validateJob(body) {
  const errors = {};
  const title = emptyToNull(body.title);
  if (!title) errors.title = 'Title is required.';
  if (title && title.length > 200) errors.title = 'Too long (max 200).';
  const oneDriveFolderUrl = emptyToNull(body.onedrive_folder_url);
  if (oneDriveFolderUrl && !/^https?:\/\/\S+$/i.test(oneDriveFolderUrl)) {
    errors.onedrive_folder_url = 'Use a full OneDrive or SharePoint link that starts with https://.';
  }

  const customerId = parseInt(body.customer_id, 10);
  if (!customerId) errors.customer_id = 'Customer is required.';
  else {
    const { data: cust } = await supabase.from('customers').select('id').eq('id', customerId).maybeSingle();
    if (!cust) errors.customer_id = 'Customer not found.';
  }

  const status = emptyToNull(body.status) || 'lead';
  if (!VALID_STATUSES.includes(status)) errors.status = 'Invalid status.';

  const scheduledDate = emptyToNull(body.scheduled_date);
  if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    errors.scheduled_date = 'Use YYYY-MM-DD.';
  }
  const scheduledTime = emptyToNull(body.scheduled_time);
  if (scheduledTime && !/^\d{2}:\d{2}$/.test(scheduledTime)) {
    errors.scheduled_time = 'Use HH:MM.';
  }

  const assignedUserId = body.assigned_to_user_id ? parseInt(body.assigned_to_user_id, 10) : null;
  if (assignedUserId) {
    const { data: u } = await supabase.from('users').select('id').eq('id', assignedUserId).eq('active', 1).maybeSingle();
    if (!u) errors.assigned_to_user_id = 'User not found or inactive.';
  }

  return {
    errors,
    data: {
      customer_id: customerId || null,
      title,
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      onedrive_folder_url: oneDriveFolderUrl,
      description: emptyToNull(body.description),
      status,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      assigned_to_user_id: assignedUserId,
      // R40: contract_value + total_paid editable on project form
      contract_value: emptyToNumber(body.contract_value),
      total_paid: emptyToNumber(body.total_paid),
    }
  };
}

function blankJob() {
  return {
    id: null, customer_id: null, title: '',
    address: '', city: '', state: '', zip: '',
    onedrive_folder_url: '',
    description: '', status: 'lead',
    scheduled_date: '', scheduled_time: '', assigned_to_user_id: null,
  };
}

const PROJECT_SORT_COLUMNS = new Set(['title', 'customer', 'location', 'status', 'created']);

function projectSortValue(job, sort) {
  if (sort === 'customer') return job.customer_name || '';
  if (sort === 'location') return [job.address, job.city, job.state].filter(Boolean).join(', ');
  if (sort === 'status') return job.status || '';
  if (sort === 'created') return job.created_at || '';
  return job.title || '';
}

function sortProjects(jobs, sort, dir) {
  const direction = dir === 'asc' ? 1 : -1;
  return [...jobs].sort((a, b) => {
    const av = projectSortValue(a, sort);
    const bv = projectSortValue(b, sort);
    const primary = String(av).localeCompare(String(bv), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (primary !== 0) return primary * direction;
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

router.get('/', async (req, res) => {
  // F4: sanitize before interpolating into PostgREST .or() filter.
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const requestedSort = (req.query.sort || 'created').trim();
  const sort = PROJECT_SORT_COLUMNS.has(requestedSort) ? requestedSort : 'created';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';

  // R37c: projects list — LEFT join customers + include RPM-native `client` field
  // so RPM-imported projects (with customer_id=NULL + free-text client) appear.
  // R37i: jobs has TWO FKs to users (assigned_to_user_id + project_manager_user_id
  // added in r36_projects_layer). PostgREST can't resolve plain `users!left(...)`
  // when multiple FKs exist — must use the FK constraint name explicitly.
  let query = supabase.from('jobs').select(
    'id, title, status, address, city, state, scheduled_date, created_at, customer_id, client, ' +
    'customers!left(name), ' +
    'assigned_to_user_id, ' +
    'users!jobs_assigned_to_user_id_fkey(name)',
    { count: 'exact', head: false }
  );
  let countQuery = supabase.from('jobs').select('*', { count: 'exact', head: true });

  if (q) {
    const like = `%${q}%`;
    // Note: cannot search customers.name via PostgREST .or() when using !left, only on jobs columns.
    query = query.or(`title.ilike.${like},address.ilike.${like},city.ilike.${like},client.ilike.${like}`);
    countQuery = countQuery.or(`title.ilike.${like},address.ilike.${like},city.ilike.${like},client.ilike.${like}`);
  }
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
    countQuery = countQuery.eq('status', status);
  }

  if (req.session.role !== 'admin') {
    const visibleProjectIds = await visibleProjectIdsForUser(req.session.userId);
    query = applyProjectVisibility(query, visibleProjectIds);
    countQuery = applyProjectVisibility(countQuery, visibleProjectIds);
  }

  // R37i: also surface the listing-query error (was being silently swallowed —
  // only countQuery.error was checked, masking PostgREST FK-resolution failures).
  const countResult = await countQuery;
  if (countResult.error) throw countResult.error;

  const total = countResult.count || 0;
  const listResult = await query.range(0, Math.max(total - 1, 0));
  if (listResult.error) throw listResult.error;
  const allJobs = (listResult.data || []).map(j => ({
    ...j,
    // R37c: fall back to RPM `client` (free text) when no customer FK is set.
    customer_name: j.customers?.name || j.client || '—',
    customer_id: j.customer_id,
    assigned_name: j.users?.name
  }));
  const sortedJobs = sortProjects(allJobs, sort, dir);
  const offset = (page - 1) * PAGE_SIZE;
  const jobs = sortedJobs.slice(offset, offset + PAGE_SIZE);

  res.render('jobs/index', {
    title: 'Projects', activeNav: 'projects',
    jobs,
    q, status, page, sort, dir,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total, statuses: VALID_STATUSES,
    watchTables: ['jobs'],
  });
});

router.get('/new', async (req, res) => {
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name, address, city, state, zip').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  if (!customers || customers.length === 0) {
    setFlash(req, 'error', 'You need a customer before you can create a project.');
    return res.redirect('/customers/new');
  }
  const job = blankJob();
  const presetCustomerId = parseInt(req.query.customer_id, 10);
  if (presetCustomerId) {
    const c = customers.find(x => x.id === presetCustomerId);
    if (c) {
      job.customer_id = c.id;
      job.address = c.address || '';
      job.city = c.city || '';
      job.state = c.state || '';
      job.zip = c.zip || '';
    }
  }
  res.render('jobs/new', {
    title: 'New project', activeNav: 'projects',
    job, customers: customers || [], users: users || [], errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/', async (req, res) => {
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name, address, city, state, zip').order('name'),
    supabase.from('users').select('id, name, email').eq('active', 1).order('name'),
  ]);
  const { errors, data } = await validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/new', {
      title: 'New project', activeNav: 'projects',
      job: { id: null, ...data }, customers: customers || [], users: users || [], errors, statuses: VALID_STATUSES
    });
  }
  const { data: newJob, error: insertError } = await supabase
    .from('jobs')
    .insert({
      customer_id: data.customer_id, title: data.title,
      address: data.address, city: data.city, state: data.state, zip: data.zip,
      onedrive_folder_url: data.onedrive_folder_url,
      description: data.description, status: data.status,
      scheduled_date: data.scheduled_date, scheduled_time: data.scheduled_time,
      assigned_to_user_id: data.assigned_to_user_id,
      contract_value: data.contract_value ?? 0,
      total_paid: data.total_paid ?? 0
    })
    .select()
    .single();
  if (insertError) throw insertError;
  if (req.session.role !== 'admin' && req.session.userId) {
    const { error: memberError } = await supabase
      .from('job_members')
      .upsert({
        job_id: newJob.id,
        user_id: Number(req.session.userId),
        role: 'admin',
      }, { onConflict: 'job_id,user_id' });
    if (memberError) throw memberError;
  }
  setFlash(req, 'success', `Project "${data.title}" created.`);
  res.redirect(`/projects/${newJob.id}`);
});

router.get('/:id/schedule', async (req, res) => {
  const id = req.params.id;
  const accessContext = await requireProjectAccess(req, res, id, 'operations');
  if (!accessContext) return;

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('*, customers!left(id, name, email, phone, address, city, state, zip), users!jobs_assigned_to_user_id_fkey(name)')
    .eq('id', id)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  job.customer_name = job.customers?.name;
  job.customer_email = job.customers?.email;
  job.customer_phone = job.customers?.phone;
  job.assigned_name = job.users?.name;

  const [
    workOrdersResult,
    usersResult,
    meetingsResult,
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select('id, display_number, status, scheduled_date, scheduled_time, scheduled_end_time, unit_number, description, assigned_to_user_id, assigned_to, created_at, users!left(name), work_order_assignees(users!work_order_assignees_user_id_fkey(id, name))')
      .eq('job_id', id)
      .order('scheduled_date', { ascending: true, nullsFirst: false })
      .order('scheduled_time', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false }),
    supabase.from('users').select('id, name, email').eq('active', 1).order('name'),
    supabase
      .from('project_meetings')
      .select('id, title, start_time, duration_minutes, location')
      .eq('job_id', id)
      .order('start_time', { ascending: true })
      .limit(6),
  ]);
  throwIfSupabaseError(workOrdersResult, 'Project schedule load failed');
  throwIfSupabaseError(usersResult, 'Project schedule users load failed');
  throwIfSupabaseError(meetingsResult, 'Project meetings load failed');

  let projectManager = null;
  if (job.project_manager_user_id) {
    const { data: pm, error: pmError } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', job.project_manager_user_id)
      .maybeSingle();
    if (pmError) throw pmError;
    projectManager = pm;
  }

  const scheduleItems = (workOrdersResult.data || []).map(wo => ({
    ...wo,
    assigned_name:
      (wo.work_order_assignees || []).map(a => a.users?.name).filter(Boolean).join(', ') ||
      wo.users?.name ||
      wo.assigned_to ||
      '',
    time_label: formatScheduleTime(wo.scheduled_time, wo.scheduled_end_time),
  }));

  res.render('jobs/schedule', {
    title: `${job.title} Schedule`,
    activeNav: 'projects',
    job,
    projectManager,
    projectAccess: accessContext.access,
    users: usersResult.data || [],
    scheduleItems,
    meetings: meetingsResult.data || [],
    form: {},
    errors: {},
  });
});

router.post('/:id/schedule/items', async (req, res) => {
  const id = req.params.id;
  const accessContext = await requireProjectAccess(req, res, id, 'operations');
  if (!accessContext) return;

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('id, title, customer_id')
    .eq('id', id)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  const description = String(req.body.description || '').trim();
  const scheduledDate = cleanDate(req.body.scheduled_date);
  const scheduledTime = cleanTime(req.body.scheduled_time);
  const scheduledEndTime = cleanTime(req.body.scheduled_end_time);
  const assignedToUserId = parseInt(req.body.assigned_to_user_id, 10) || null;
  const status = normalizeProjectScheduleStatus(req.body.status, !!scheduledDate);

  if (!description) {
    setFlash(req, 'error', 'Schedule item description is required.');
    return res.redirect(`/projects/${id}/schedule`);
  }
  if (req.body.scheduled_date && !scheduledDate) {
    setFlash(req, 'error', 'Use a valid schedule date.');
    return res.redirect(`/projects/${id}/schedule`);
  }

  const users = await loadActiveUsers();
  const assignee = users.find(u => Number(u.id) === Number(assignedToUserId));
  const next = await numbering.nextRootWoNumber();
  const insertPayload = {
    customer_id: job.customer_id || null,
    job_id: parseInt(id, 10),
    parent_wo_id: null,
    wo_number_main: next.main,
    wo_number_sub: next.sub,
    display_number: next.display,
    status,
    unit_number: String(req.body.unit_number || '').trim() || null,
    description,
    scheduled_date: scheduledDate,
    scheduled_time: scheduledTime,
    scheduled_end_time: scheduledEndTime,
    assigned_to_user_id: assignee ? assignee.id : null,
    assigned_to: assignee ? assignee.name : null,
    notes: null,
  };

  const { data: created, error: createError } = await supabase
    .from('work_orders')
    .insert(insertPayload)
    .select('id, display_number')
    .single();
  if (createError) throw createError;

  if (assignee) {
    const { error: assigneeError } = await supabase
      .from('work_order_assignees')
      .insert({
        work_order_id: created.id,
        user_id: assignee.id,
        assigned_at: new Date().toISOString(),
        assigned_by_user_id: req.session.userId || null,
      });
    if (assigneeError) console.warn('[project-schedule] assignee insert failed:', assigneeError.message);
  }

  await supabase.from('audit_logs').insert({
    user_id: req.session.userId || null,
    entity_type: 'work_order',
    entity_id: created.id,
    action: 'project_schedule_item_created',
    before_json: null,
    after_json: { project_id: Number(id), display_number: created.display_number, scheduled_date: scheduledDate },
    source: 'user',
  });

  setFlash(req, 'success', `WO-${created.display_number} added to the project schedule.`);
  res.redirect(`/projects/${id}/schedule`);
});

router.post('/:id/schedule/items/:woId', async (req, res) => {
  const id = req.params.id;
  const woId = req.params.woId;
  const accessContext = await requireProjectAccess(req, res, id, 'operations');
  if (!accessContext) return;

  const { data: existing, error: existingError } = await supabase
    .from('work_orders')
    .select('id, display_number, job_id')
    .eq('id', woId)
    .eq('job_id', id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Schedule item not found.' });

  const description = String(req.body.description || '').trim();
  const scheduledDate = cleanDate(req.body.scheduled_date);
  const scheduledTime = cleanTime(req.body.scheduled_time);
  const scheduledEndTime = cleanTime(req.body.scheduled_end_time);
  const assignedToUserId = parseInt(req.body.assigned_to_user_id, 10) || null;
  const status = normalizeProjectScheduleStatus(req.body.status, !!scheduledDate);

  if (!description) {
    setFlash(req, 'error', 'Schedule item description is required.');
    return res.redirect(`/projects/${id}/schedule`);
  }
  if (req.body.scheduled_date && !scheduledDate) {
    setFlash(req, 'error', 'Use a valid schedule date.');
    return res.redirect(`/projects/${id}/schedule`);
  }

  const users = await loadActiveUsers();
  const assignee = users.find(u => Number(u.id) === Number(assignedToUserId));
  const updatePayload = {
    status,
    unit_number: String(req.body.unit_number || '').trim() || null,
    description,
    scheduled_date: scheduledDate,
    scheduled_time: scheduledTime,
    scheduled_end_time: scheduledEndTime,
    assigned_to_user_id: assignee ? assignee.id : null,
    assigned_to: assignee ? assignee.name : null,
  };

  const { error: updateError } = await supabase
    .from('work_orders')
    .update(updatePayload)
    .eq('id', existing.id)
    .eq('job_id', id);
  if (updateError) throw updateError;

  const { error: removeAssigneesError } = await supabase
    .from('work_order_assignees')
    .delete()
    .eq('work_order_id', existing.id);
  if (removeAssigneesError) throw removeAssigneesError;
  if (assignee) {
    const { error: assigneeError } = await supabase
      .from('work_order_assignees')
      .insert({
        work_order_id: existing.id,
        user_id: assignee.id,
        assigned_at: new Date().toISOString(),
        assigned_by_user_id: req.session.userId || null,
      });
    if (assigneeError) console.warn('[project-schedule] assignee update failed:', assigneeError.message);
  }

  await supabase.from('audit_logs').insert({
    user_id: req.session.userId || null,
    entity_type: 'work_order',
    entity_id: existing.id,
    action: 'project_schedule_item_updated',
    before_json: null,
    after_json: { project_id: Number(id), display_number: existing.display_number, ...updatePayload },
    source: 'user',
  });

  setFlash(req, 'success', `WO-${existing.display_number} updated.`);
  res.redirect(`/projects/${id}/schedule`);
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  // R37i: jobs has TWO FKs to users (assigned_to_user_id + project_manager_user_id from r36).
  // Use explicit FK constraint name on users embed to avoid ambiguity error.
  const { data: job, error: jError } = await supabase
    .from('jobs')
    .select('*, customers!left(id, name, email, phone, address, city, state, zip), users!jobs_assigned_to_user_id_fkey(name)')
    .eq('id', id)
    .maybeSingle();
  if (jError) throw jError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  // Flatten nested data to match view expectations
  job.customer_name = job.customers?.name;
  job.customer_email = job.customers?.email;
  job.customer_phone = job.customers?.phone;
  job.assigned_name = job.users?.name;

  // D-007: financial roll-up from v_job_financials. View aggregates contract,
  // change orders, vendor commitments, and posted bills server-side.
  const finResult = await supabase
    .from('v_job_financials')
    .select('*')
    .eq('job_id', id)
    .maybeSingle();
  throwIfSupabaseError(finResult, 'Project financials load failed');
  const fin = finResult.data;
  const financials = fin || {
    contract_value: job.contract_value || 0,
    budget_mode: job.budget_mode || 'manual',
    revenue_projected: 0, revenue_billed: 0,
    cost_committed: 0, cost_actual: 0,
    profit_projected: 0,
    progress_percentage: job.progress_percentage || 0,
  };

  // D-007a: Financial Command Panel — load project financial snapshot
  let projectFinancials = null;
  let projectFinancialsError = null;
  try {
    const { getProjectFinancials } = require('../services/project-financials');
    projectFinancials = await getProjectFinancials(id);
  } catch (e) {
    projectFinancialsError = e.message;
    console.warn('[financial-panel] failed to load for job', id, ':', e.message);
  }

  // F-011: contractor rollup — contract value from RFP vs billed from bills
  let contractorRollup = [];
  try {
    contractorRollup = await getProjectContractorRollup(id);
  } catch (e) {
    console.warn('[contractor-rollup] failed for job', id, ':', e.message);
  }

  // R37n: load vendor_invoices + project_contractors (RPM-style data) alongside
  // FORGE-native tables. Plymouth Square (and future RPM imports) carry 200+
  // vendor invoices that need to render on the project show page.
  const [
    workOrdersResult,
    changeOrdersResult,
    lineItemsResult,
    membersResult,
    vendorsResult,
    usersResult,
    vendorInvoicesResult,
    projectContractorsResult,
    paymentsResult,
    sovItemsResult,
    decisionsResult,
    rfpsResult,
  ] = await Promise.all([
    supabase
      .from('work_orders')
      .select('id, display_number, wo_number_main, wo_number_sub, parent_wo_id, status, scheduled_date, unit_number, assigned_to, assigned_to_user_id, completed_date, created_at, work_order_assignees(users!work_order_assignees_user_id_fkey(id, name, email, active))')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .order('wo_number_sub', { ascending: true }),
    supabase
      .from('change_orders')
      .select('id, description, vendor_amount, customer_amount, status, approved_by_user_id, created_at, vendors!left(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('job_vendor_line_items')
      .select('id, description, quantity, unit_cost, sort_order, vendor_id, vendors!left(name)')
      .eq('job_id', id)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('job_members')
      .select('id, role, user_id, users!inner(name, email)')
      .eq('job_id', id)
      .order('id', { ascending: true }),
    supabase.from('vendors').select('id, name').order('name'),
    supabase.from('users').select('id, name, email, active').eq('active', 1).order('name'),
    supabase
      .from('vendor_invoices')
      .select('id, amount, description, invoice_number, vendor_id, created_at, vendors!left(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('project_contractors')
      .select('id, vendor_id, contract_amount, contract_notes, vendors!left(name)')
      .eq('job_id', id),
    supabase
      .from('project_payments')
      .select('*')
      .eq('job_id', id)
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('project_sov_items')
      .select('*')
      .eq('job_id', id)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('project_decisions')
      .select('*, users!project_decisions_assigned_to_user_id_fkey(name)')
      .eq('job_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('project_rfps')
      .select('*')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .then(r => r)
      .catch(function(error) { return { data: [], error }; }),
  ]);

  throwIfSupabaseError(workOrdersResult, 'Project work orders load failed');
  throwIfSupabaseError(changeOrdersResult, 'Project change orders load failed');
  throwIfSupabaseError(lineItemsResult, 'Project vendor commitments load failed');
  throwIfSupabaseError(membersResult, 'Project members load failed');
  throwIfSupabaseError(vendorsResult, 'Vendor options load failed');
  throwIfSupabaseError(usersResult, 'Active users load failed');
  throwIfSupabaseError(vendorInvoicesResult, 'Project vendor invoices load failed');
  throwIfSupabaseError(projectContractorsResult, 'Project contractor links load failed');
  throwIfSupabaseError(paymentsResult, 'Project payments load failed');
  throwIfSupabaseError(sovItemsResult, 'Project SOV load failed');
  throwIfSupabaseError(decisionsResult, 'Project decisions load failed');
  if (rfpsResult.error && !isMissingOptionalRfpTable(rfpsResult.error)) {
    throwIfSupabaseError(rfpsResult, 'Project RFPs load failed');
  }

  const workOrders = workOrdersResult.data;
  const changeOrders = changeOrdersResult.data;
  const lineItems = lineItemsResult.data;
  const members = membersResult.data;
  const vendors = vendorsResult.data;
  const users = usersResult.data;
  const vendorInvoices = vendorInvoicesResult.data;
  const projectContractors = projectContractorsResult.data;
  const payments = paymentsResult.data;
  const sovItems = sovItemsResult.data;
  const decisions = decisionsResult.data;
  const rfps = rfpsResult.error ? [] : rfpsResult.data;
  const normalizedMembers = (members || []).map(m => ({
    ...m,
    role: normalizeProjectRole(m.role),
    user_name: m.users?.name,
    user_email: m.users?.email,
  }));
  const access = projectAccess({ req, job, members: normalizedMembers });
  if (!hasAnyProjectAccess(access)) {
    return denyProjectAccess(res, 'You are not assigned to this project.');
  }

  // F-001: load decision assignees (multi-user)
  var decisionAssignees = {};
  try {
    if (decisions && decisions.length) {
      var decIds = decisions.map(function(d){ return d.id; });
      var { data: daData, error: daError } = await supabase
        .from('decision_assignees')
        .select('decision_id, user_id, users!inner(name)')
        .in('decision_id', decIds);
      if (!daError && daData) {
        daData.forEach(function(a){
          if (!decisionAssignees[a.decision_id]) decisionAssignees[a.decision_id] = [];
          decisionAssignees[a.decision_id].push({ id: a.user_id, name: a.users?.name || 'Unknown' });
        });
      }
    }
  } catch(e) { /* table may not exist yet */ }

  // D-078: pull awarded RFP amounts into cost_committed
  if (rfps && rfps.length) {
    try {
      const rfpIds = rfps.filter(r => r.status === 'awarded').map(r => r.id);
      if (rfpIds.length) {
        const { data: rfpItemTotals, error: rfpItemTotalsError } = await supabase
          .from('rfp_line_items')
          .select('total_with_markup')
          .in('rfp_id', rfpIds);
        if (rfpItemTotalsError) throw rfpItemTotalsError;
        const rfpCommitted = (rfpItemTotals || []).reduce((s, i) => s + Number(i.total_with_markup || 0), 0);
        financials.cost_committed = (financials.cost_committed || 0) + rfpCommitted;
        // Recalculate projected profit
        financials.profit_projected = (financials.revenue_projected || 0) - (financials.cost_committed || 0) - (financials.cost_actual || 0);
      }
    } catch (e) {
      if (!isMissingOptionalRfpTable(e)) throw e;
    }
  }

  const paymentTotal = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);

  // Resolve approver names for change orders (avoid ambiguous users FK alias).
  const approverIds = Array.from(new Set((changeOrders || []).map(co => co.approved_by_user_id).filter(Boolean)));
  let approverMap = {};
  if (approverIds.length) {
    const { data: approvers, error: approversError } = await supabase.from('users').select('id, name').in('id', approverIds);
    if (approversError) throw approversError;
    (approvers || []).forEach(u => { approverMap[u.id] = u.name; });
  }

  // Project manager lookup (uses denormalized FK on jobs.project_manager_user_id)
  let projectManager = null;
  if (job.project_manager_user_id) {
    const { data: pm, error: pmError } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', job.project_manager_user_id)
      .maybeSingle();
    if (pmError) throw pmError;
    projectManager = pm;
  }

  const chatMentionUsers = buildChatMentionUsers({
    members: normalizedMembers,
    users,
    projectManager,
    job,
    workOrders,
  });

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
      console.warn('[rfp] could not load line items (table may not exist yet):', e.message);
    }
  }

  // R37n: aggregate vendor_invoices by vendor for the vendor-spend table.
  // Each group has running total + per-invoice list. Orphan invoices (no vendor)
  // get grouped under "Unknown vendor" so they don't disappear from the view.
  const invoicesByVendor = {};
  (vendorInvoices || []).forEach(vi => {
    const vKey = vi.vendor_id || 0;
    const vName = vi.vendors?.name || 'Unknown vendor';
    if (!invoicesByVendor[vKey]) {
      invoicesByVendor[vKey] = { vendor_id: vKey, vendor_name: vName, invoices: [], total: 0 };
    }
    invoicesByVendor[vKey].invoices.push({
      id: vi.id,
      amount: Number(vi.amount) || 0,
      description: vi.description || '',
      invoice_number: vi.invoice_number || '',
      created_at: vi.created_at,
    });
    invoicesByVendor[vKey].total += Number(vi.amount) || 0;
  });
  const vendorSpend = Object.values(invoicesByVendor).sort((a, b) => b.total - a.total);
  const vendorInvoiceGrandTotal = vendorSpend.reduce((s, v) => s + v.total, 0);

  // D-036: merge contract_amount from project_contractors into vendorSpend
  const contractorMap = {};
  (projectContractors || []).forEach(pc => {
    if (pc.vendor_id) contractorMap[pc.vendor_id] = { contract_amount: pc.contract_amount || 0, contract_notes: pc.contract_notes || '' };
  });
  vendorSpend.forEach(vs => {
    const c = contractorMap[vs.vendor_id];
    vs.contract_amount = c ? Number(c.contract_amount) : 0;
    vs.contract_notes = c ? c.contract_notes : '';
    vs.remaining = Math.max(0, vs.contract_amount - vs.total);
  });

  res.render('jobs/show', {
    title: job.title, activeNav: 'projects',
    job, financials, projectManager,
    workOrders: workOrders || [],
    vendors: vendors || [],
    users: users || [],
    changeOrders: (changeOrders || []).map(co => ({
      ...co,
      vendor_name: co.vendors?.name,
      approver_name: approverMap[co.approved_by_user_id] || null,
    })),
    lineItems: (lineItems || []).map(li => ({
      ...li,
      vendor_name: li.vendors?.name,
      total_cost: Number(li.quantity || 0) * Number(li.unit_cost || 0),
    })),
    members: normalizedMembers,
    chatMentionUsers,
    projectAccess: access,
    // R37n: RPM-style vendor invoice rollup.
    vendorSpend,
    vendorInvoiceGrandTotal,
    vendorInvoiceCount: (vendorInvoices || []).length,
    projectContractors: (projectContractors || []).map(pc => ({
      id: pc.id,
      vendor_id: pc.vendor_id,
      vendor_name: pc.vendors?.name || '—',
    })),
    // D-007a: Financial Command Panel
    projectFinancials: access.canSeeBilling ? projectFinancials : null,
    projectFinancialsError,
    // F-011: contractor/vendor rollup
    contractorRollup: access.canSeeBilling ? withContractKeys(contractorRollup) : [],
    // D-024a: customer payment ledger
    payments: access.canSeeBilling ? (payments || []).map(p => ({ ...p })) : [],
    paymentTotal: access.canSeeBilling ? (paymentTotal || 0) : 0,
    // D-024b: Schedule of Values
    sovItems: sovItems || [],
    sovTotalScheduled: (sovItems || []).reduce((s, i) => s + Number(i.scheduled_value || 0), 0),
    sovTotalPrev: (sovItems || []).reduce((s, i) => s + Number(i.previous_billed || 0), 0),
    sovTotalCurrent: (sovItems || []).reduce((s, i) => s + Number(i.current_billed || 0), 0),
    sovFmt: function(n) { const num = Number(n); return isFinite(num) ? num.toFixed(2) : '0.00'; },
    // D-024c: RFI / decision log
    decisions: (function() {
      return (decisions || []).map(function(d) {
        var usr = d.users || {};
        return { ...d, assigned_to_name: usr.name || null, assignees: decisionAssignees[d.id] || [] };
      });
    })(),
    // D-093: RFP / bid comparison
    rfps: rfps || [],
    rfpItemsMap,
    watchTables: ['jobs', 'work_orders'],
  });
});

router.get('/:id/financials', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;

  const { data: job, error: jError } = await supabase
    .from('jobs')
    .select('*, customers!left(id, name, email, phone, address, city, state, zip), users!jobs_assigned_to_user_id_fkey(name)')
    .eq('id', id)
    .maybeSingle();
  if (jError) throw jError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  job.customer_name = job.customers?.name || job.client;
  job.customer_email = job.customers?.email;
  job.customer_phone = job.customers?.phone;
  job.assigned_name = job.users?.name;
  const access = allowed.access;

  let projectManager = null;
  if (job.project_manager_user_id) {
    const { data: pm, error: pmError } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('id', job.project_manager_user_id)
      .maybeSingle();
    if (pmError) throw pmError;
    projectManager = pm;
  }

  let projectFinancials = null;
  let projectFinancialsError = null;
  try {
    const { getProjectFinancials } = require('../services/project-financials');
    projectFinancials = await getProjectFinancials(id);
  } catch (e) {
    projectFinancialsError = e.message;
    console.warn('[financials-page] failed to load for job', id, ':', e.message);
  }

  let contractorRollup = [];
  try {
    contractorRollup = await getProjectContractorRollup(id);
  } catch (e) {
    console.warn('[financials-page] contractor rollup failed for job', id, ':', e.message);
  }

  res.render('jobs/financials', {
    title: `${job.title} Financials`,
    activeNav: 'projects',
    job,
    projectManager,
    projectAccess: access,
    projectFinancials,
    projectFinancialsError,
    contractorRollup: withContractKeys(contractorRollup),
  });
});

router.get('/:id/contracts', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('id, title, customer_id, client, address, city, state, zip, status, created_at, customers!left(name)')
    .eq('id', id)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  job.customer_name = job.customers?.name || job.client || '—';

  let contractorRollup = [];
  try {
    contractorRollup = await getProjectContractorRollup(id);
  } catch (e) {
    console.warn('[contracts] contractor rollup failed for job', id, ':', e.message);
  }

  res.render('jobs/contracts', {
    title: `${job.title} Contracts`,
    activeNav: 'projects',
    job,
    projectAddress: projectAddress(job),
    projectAccess: allowed.access,
    contractorRollup: withContractKeys(contractorRollup),
  });
});

router.get('/:id/contracts/:contractorKey.pdf', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const contractorName = decodeContractorKey(req.params.contractorKey);
  const data = await loadContractData(id, contractorName);
  if (!data) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contract scope not found.' });

  const buf = await renderSubcontractAgreementPdf({
    company: data.company,
    project: data.job,
    customer: data.customer,
    contractor: data.contractor,
    vendorName: data.vendorName,
    items: data.items,
    contractTotal: data.contractTotal,
    createdBy: req.session?.name || req.session?.email || '',
  });

  const filename = `${slugPart(data.job.title)}-${slugPart(data.vendorName)}-contract.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buf);
});

router.get('/:id/contracts/:contractorKey', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const contractorName = decodeContractorKey(req.params.contractorKey);
  const data = await loadContractData(id, contractorName);
  if (!data) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Contract scope not found.' });

  res.render('jobs/contract-preview', {
    title: `${data.job.title} Contract`,
    activeNav: 'projects',
    job: data.job,
    customer: data.customer,
    contractor: data.contractor,
    vendorName: data.vendorName,
    items: data.items,
    contractTotal: data.contractTotal,
    contractorKey: req.params.contractorKey,
  });
});

router.get('/:id/edit', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  const [{ data: job }, { data: customers }, { data: users }] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', id).maybeSingle(),
    supabase.from('customers').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  res.render('jobs/edit', {
    title: `Edit ${job.title}`, activeNav: 'projects',
    job, customers: customers || [], users: users || [], errors: {}, statuses: VALID_STATUSES
  });
});

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  const { data: job, error: findError } = await supabase.from('jobs').select('id, title, project_manager_user_id, assigned_to_user_id').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  const [{ data: customers }, { data: users }] = await Promise.all([
    supabase.from('customers').select('id, name').order('name'),
    supabase.from('users').select('id, name').eq('active', 1).order('name'),
  ]);
  const { errors, data } = await validateJob(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('jobs/edit', {
      title: `Edit ${job.title}`, activeNav: 'projects',
      job: { id: job.id, ...data }, customers: customers || [], users: users || [], errors, statuses: VALID_STATUSES
    });
  }
  // R40: contract_value + total_paid are optional on edit. If not present in
  // form body, leave the existing values untouched (don't overwrite to 0).
  const updatePatch = {
    customer_id: data.customer_id, title: data.title,
    address: data.address, city: data.city, state: data.state, zip: data.zip,
    onedrive_folder_url: data.onedrive_folder_url,
    description: data.description, status: data.status,
    scheduled_date: data.scheduled_date, scheduled_time: data.scheduled_time,
    assigned_to_user_id: data.assigned_to_user_id,
    updated_at: new Date().toISOString()
  };
  if (data.contract_value !== null) updatePatch.contract_value = data.contract_value;
  if (data.total_paid !== null) updatePatch.total_paid = data.total_paid;
  const { error: updateError } = await supabase
    .from('jobs')
    .update(updatePatch)
    .eq('id', id);
  if (updateError) throw updateError;
  setFlash(req, 'success', `Project "${data.title}" updated.`);
  res.redirect(`/projects/${id}`);
});

router.post('/:id/delete', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  const { data: job, error: findError } = await supabase.from('jobs').select('id, title, project_manager_user_id, assigned_to_user_id').eq('id', id).maybeSingle();
  if (findError) throw findError;
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
  const { count: woCount, error: woCountError } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).eq('job_id', id);
  if (woCountError) throw woCountError;
  if (woCount) {
    setFlash(req, 'error', `Cannot delete "${job.title}" — it has ${woCount} work order(s).`);
    return res.redirect(`/projects/${id}`);
  }
  const { error: deleteError } = await supabase.from('jobs').delete().eq('id', id);
  if (deleteError) throw deleteError;
  setFlash(req, 'success', `Project "${job.title}" deleted.`);
  res.redirect('/projects');
});

// ============================================================
// D-007 sub-resources: change orders, vendor line items, members.
// All POST/DELETE endpoints respond with the freshly-rendered section
// partial so HTMX hx-swap="outerHTML" gets a self-contained DOM block.
// ============================================================

const VALID_CO_STATUSES = ['pending', 'approved', 'rejected', 'invoiced'];
const VALID_ROLES = ['superintendent', 'accountant', 'admin', 'pre_construction'];
const LEGACY_PROJECT_ROLE_MAP = {
  owner: 'admin',
  manager: 'admin',
  member: 'superintendent',
};

function normalizeProjectRole(role) {
  const raw = String(role || '').toLowerCase();
  return LEGACY_PROJECT_ROLE_MAP[raw] || (VALID_ROLES.includes(raw) ? raw : 'superintendent');
}

function projectAccess({ req, job, members }) {
  const userId = Number(req.session?.userId);
  const appRole = req.session?.role;
  const appFull = appRole === 'admin';
  const isProjectManager =
    userId &&
    (Number(job.project_manager_user_id) === userId || Number(job.assigned_to_user_id) === userId);
  const member = (members || []).find(m => Number(m.user_id) === userId);
  const projectRole = isProjectManager ? 'project_manager' : normalizeProjectRole(member?.role);
  const projectFull = isProjectManager || normalizeProjectRole(member?.role) === 'admin';
  const full = appFull || projectFull;
  const billing = full || projectRole === 'accountant';
  const operations = full || projectRole === 'superintendent' || projectRole === 'pre_construction';
  return {
    projectRole,
    isProjectManager: !!isProjectManager,
    canSeeBilling: !!billing,
    canSeeOperations: !!operations,
    canManageMembers: !!full,
  };
}

async function loadProjectAccess(req, job) {
  const members = await loadMembers(job.id);
  return projectAccess({ req, job, members });
}

function denyProjectAccess(res, message) {
  return res.status(403).render('error', {
    title: 'Forbidden',
    code: 403,
    message: message || 'You do not have access to this project area.',
  });
}

async function requireProjectAccess(req, res, id, capability) {
  const job = await requireProjectId(id);
  if (!job) {
    res.status(404).send('Project not found');
    return null;
  }
  const access = await loadProjectAccess(req, job);
  const allowed =
    capability === 'billing' ? access.canSeeBilling :
    capability === 'operations' ? access.canSeeOperations :
    capability === 'manage' ? access.canManageMembers :
    (access.canSeeBilling || access.canSeeOperations);
  if (!allowed) {
    const message =
      capability === 'billing' ? 'This project area contains billing or cost information.' :
      capability === 'manage' ? 'This project area requires project admin access.' :
      'You are not assigned to this project.';
    denyProjectAccess(res, message);
    return null;
  }
  return { job, access };
}

async function loadChangeOrders(jobId) {
  const { data, error } = await supabase
    .from('change_orders')
    .select('id, description, vendor_amount, customer_amount, status, approved_by_user_id, created_at, vendors!left(name)')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const list = data || [];
  const approverIds = Array.from(new Set(list.map(co => co.approved_by_user_id).filter(Boolean)));
  let approverMap = {};
  if (approverIds.length) {
    const { data: approvers, error: approverError } = await supabase.from('users').select('id, name').in('id', approverIds);
    if (approverError) throw approverError;
    (approvers || []).forEach(u => { approverMap[u.id] = u.name; });
  }
  return list.map(co => ({ ...co, vendor_name: co.vendors?.name, approver_name: approverMap[co.approved_by_user_id] || null }));
}

async function loadLineItems(jobId) {
  const { data, error } = await supabase
    .from('job_vendor_line_items')
    .select('id, description, quantity, unit_cost, sort_order, vendor_id, vendors!left(name)')
    .eq('job_id', jobId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(li => ({
    ...li,
    vendor_name: li.vendors?.name,
    total_cost: Number(li.quantity || 0) * Number(li.unit_cost || 0),
  }));
}

async function requireManagerProjectAccess(req, res, job) {
  if (req.session.role !== 'manager') return true; // admins always pass
  const userId = Number(req.session.userId);
  if (Number(job.project_manager_user_id) === userId || Number(job.assigned_to_user_id) === userId) return true;
  const { data: membership } = await supabase
    .from('job_members')
    .select('id')
    .eq('job_id', job.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (membership) return true;
  return false;
}

async function loadMembers(jobId) {
  const { data, error } = await supabase
    .from('job_members')
    .select('id, role, user_id, users!inner(name, email)')
    .eq('job_id', jobId)
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(m => ({ ...m, role: normalizeProjectRole(m.role), user_name: m.users?.name, user_email: m.users?.email }));
}

async function loadVendors() {
  const { data, error } = await supabase.from('vendors').select('id, name').order('name');
  if (error) throw error;
  return data || [];
}

async function loadActiveUsers() {
  const { data, error } = await supabase.from('users').select('id, name, email').eq('active', 1).order('name');
  if (error) throw error;
  return data || [];
}

async function renderMembersSection(res, id, access, options = {}) {
  const [members, users] = await Promise.all([loadMembers(id), loadActiveUsers()]);
  return res.render('jobs/_members_list', {
    job: { id },
    members,
    users,
    projectAccess: access,
    memberError: options.memberError || null,
    memberForm: options.memberForm || {},
  });
}

async function requireProjectId(id) {
  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, project_manager_user_id, assigned_to_user_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return job;
}

// ---------- Change orders ----------

router.get('/:id/change-orders', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

router.post('/:id/change-orders', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const description = emptyToNull(req.body.description);
  if (!description) return res.status(400).send('Description required');
  const vendorId = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) || null : null;
  const vendorAmt = req.body.vendor_amount === '' || req.body.vendor_amount == null ? null : Number(req.body.vendor_amount);
  const custAmt = req.body.customer_amount === '' || req.body.customer_amount == null ? null : Number(req.body.customer_amount);
  const { error } = await supabase.from('change_orders').insert({
    job_id: parseInt(id, 10),
    vendor_id: vendorId,
    description,
    vendor_amount: vendorAmt,
    customer_amount: custAmt,
    status: 'pending',
  });
  if (error) throw error;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

router.post('/:id/change-orders/:coId/approve', async (req, res) => {
  const { id, coId } = req.params;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const userId = req.session && req.session.userId ? req.session.userId : null;
  const { error } = await supabase
    .from('change_orders')
    .update({
      status: 'approved',
      approved_by_user_id: userId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', coId)
    .eq('job_id', id);
  if (error) throw error;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

router.post('/:id/change-orders/:coId/reject', async (req, res) => {
  const { id, coId } = req.params;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const userId = req.session && req.session.userId ? req.session.userId : null;
  const { error } = await supabase
    .from('change_orders')
    .update({
      status: 'rejected',
      approved_by_user_id: userId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', coId)
    .eq('job_id', id);
  if (error) throw error;
  const [changeOrders, vendors] = await Promise.all([loadChangeOrders(id), loadVendors()]);
  res.render('jobs/_change_orders_table', { job: { id }, changeOrders, vendors });
});

// ---------- Vendor line items ----------

router.get('/:id/line-items', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const [lineItems, vendors] = await Promise.all([loadLineItems(id), loadVendors()]);
  res.render('jobs/_line_items_table', { job: { id }, lineItems, vendors });
});

router.post('/:id/line-items', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const description = emptyToNull(req.body.description);
  if (!description) return res.status(400).send('Description required');
  const vendorId = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) || null : null;
  const quantity = req.body.quantity === '' || req.body.quantity == null ? 1 : Number(req.body.quantity);
  const unitCost = req.body.unit_cost === '' || req.body.unit_cost == null ? 0 : Number(req.body.unit_cost);
  // Compute next sort_order so new items append.
  const { data: maxRow, error: maxRowError } = await supabase
    .from('job_vendor_line_items')
    .select('sort_order')
    .eq('job_id', id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxRowError) throw maxRowError;
  const nextSort = (maxRow && Number.isFinite(Number(maxRow.sort_order)) ? Number(maxRow.sort_order) : 0) + 1;
  const { error } = await supabase.from('job_vendor_line_items').insert({
    job_id: parseInt(id, 10),
    vendor_id: vendorId,
    description,
    quantity,
    unit_cost: unitCost,
    sort_order: nextSort,
  });
  if (error) throw error;
  const [lineItems, vendors] = await Promise.all([loadLineItems(id), loadVendors()]);
  res.render('jobs/_line_items_table', { job: { id }, lineItems, vendors });
});

router.delete('/:id/line-items/:itemId', async (req, res) => {
  const { id, itemId } = req.params;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const { error } = await supabase
    .from('job_vendor_line_items')
    .delete()
    .eq('id', itemId)
    .eq('job_id', id);
  if (error) throw error;
  const [lineItems, vendors] = await Promise.all([loadLineItems(id), loadVendors()]);
  res.render('jobs/_line_items_table', { job: { id }, lineItems, vendors });
});

// ---------- Vendor Invoices ----------

router.post('/:id/vendor-invoices', async (req, res) => {
  const id = req.params.id;
  const jobId = parseInt(id, 10);
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const vendorName = emptyToNull(req.body.vendor_name);
  if (!vendorName) return res.status(400).send('Vendor name required');
  const amount = req.body.amount === '' || req.body.amount == null ? null : Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).send('Valid amount required');

  // R37q-fix (GPT G-010 P0): vendor_invoices.vendor_id is FK, not vendor_name.
  // Resolve vendor by exact-name match (case-insensitive), creating if missing.
  // Also auto-link to project_contractors so the new vendor shows up in the
  // datalist on next render.
  let vendorId = null;
  const { data: existing, error: existingVendorError } = await supabase
    .from('vendors')
    .select('id')
    .ilike('name', vendorName)
    .maybeSingle();
  if (existingVendorError) throw existingVendorError;
  if (existing) {
    vendorId = existing.id;
  } else {
    const { data: created, error: cErr } = await supabase
      .from('vendors')
      .insert({ name: vendorName, mock: 0 })
      .select('id')
      .single();
    if (cErr) throw cErr;
    vendorId = created.id;
  }
  // Ensure project_contractor link exists (idempotent).
  const { error: contractorLinkError } = await supabase
    .from('project_contractors')
    .upsert({ job_id: jobId, vendor_id: vendorId }, { onConflict: 'job_id,vendor_id', ignoreDuplicates: true });
  if (contractorLinkError) throw contractorLinkError;

  const { error } = await supabase.from('vendor_invoices').insert({
    job_id: jobId,
    vendor_id: vendorId,
    invoice_number: emptyToNull(req.body.invoice_number),
    description: emptyToNull(req.body.description),
    amount,
  });
  if (error) throw error;
  setFlash(req, 'success', `Vendor invoice $${amount.toFixed(2)} added for ${vendorName}.`);
  res.redirect(`/projects/${id}`);
});

// ---------- Customer Payments ----------

router.get('/:id/payments', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const { data: payments, error: pErr } = await supabase
    .from('project_payments')
    .select('*')
    .eq('job_id', id)
    .order('payment_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (pErr) throw pErr;
  const paymentTotal = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  res.render('jobs/_payments_timeline', {
    layout: false, jobId: id, payments: payments || [],
    paymentTotal, fmt,
  });
});

router.post('/:id/payments', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).send('Valid amount required');
  const { error } = await supabase.from('project_payments').insert({
    job_id: parseInt(id, 10),
    amount,
    payment_date: req.body.payment_date || new Date().toISOString().slice(0,10),
    method: req.body.method || 'check',
    reference: emptyToNull(req.body.reference),
    notes: emptyToNull(req.body.notes),
    received_by_user_id: req.session.userId || null,
  });
  if (error) throw error;
  // Update jobs.total_paid
  const { data: payments, error: paymentsErr } = await supabase.from('project_payments').select('amount').eq('job_id', id);
  if (paymentsErr) throw paymentsErr;
  const total = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const { error: totalErr } = await supabase.from('jobs').update({ total_paid: total }).eq('id', id);
  if (totalErr) throw totalErr;
  setFlash(req, 'success', `Payment of $${amount.toFixed(2)} recorded.`);
  res.redirect(`/projects/${id}`);
});

// ---------- SOV (D-024b) ----------

router.post('/:id/sov-items', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const { error } = await supabase.from('project_sov_items').insert({
    job_id: parseInt(id, 10),
    code: req.body.code || null,
    description: req.body.description,
    scheduled_value: Number(req.body.scheduled_value) || 0,
    percent_complete: Number(req.body.percent_complete) || 0,
    retainage_rate: Number(req.body.retainage_rate) || 0,
    sort_order: 0,
  });
  if (error) throw error;
  setFlash(req, 'success', 'SOV item added.');
  res.redirect('/projects/' + id);
});

router.post('/:id/sov-items/:itemId/delete', async (req, res) => {
  const allowed = await requireProjectAccess(req, res, req.params.id, 'billing');
  if (!allowed) return;
  const { error } = await supabase.from('project_sov_items').delete().eq('id', req.params.itemId).eq('job_id', req.params.id);
  if (error) {
    setFlash(req, 'error', 'SOV item delete failed: ' + error.message);
    return res.redirect('/projects/' + req.params.id);
  }
  setFlash(req, 'success', 'SOV item deleted.');
  res.redirect('/projects/' + req.params.id);
});

// D-024b-fix: inline SOV field update
router.post('/:id/sov-items/:itemId/update', async (req, res) => {
  const allowed = await requireProjectAccess(req, res, req.params.id, 'billing');
  if (!allowed) return;
  const { field, value } = req.body;
  const allowedFields = ['current_billed', 'percent_complete', 'retainage_rate'];
  if (!allowedFields.includes(field)) return res.status(400).send('Invalid field');
  const numVal = parseFloat(value) || 0;
  const clamped = field === 'percent_complete' || field === 'retainage_rate'
    ? Math.min(100, Math.max(0, numVal)) : Math.max(0, numVal);
  const { error } = await supabase.from('project_sov_items').update({ [field]: clamped }).eq('id', req.params.itemId).eq('job_id', req.params.id);
  if (error) { setFlash(req, 'error', 'Update failed: ' + error.message); return res.redirect('/projects/' + req.params.id); }
  setFlash(req, 'success', field.replace(/_/g, ' ') + ' updated to ' + clamped);
  res.redirect('/projects/' + req.params.id);
});

router.post('/:id/draws/generate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const { data: items, error: itemsError } = await supabase.from('project_sov_items').select('*').eq('job_id', id).order('id');
  if (itemsError) throw itemsError;
  if (!items || items.length === 0) { setFlash(req, 'error', 'No SOV items to bill.'); return res.redirect('/projects/' + id); }
  const { data: draws, error: drawsError } = await supabase.from('project_draws').select('draw_number').eq('job_id', id).order('draw_number', { ascending: false }).limit(1);
  if (drawsError) throw drawsError;
  const drawNum = (draws && draws.length > 0 ? draws[0].draw_number : 0) + 1;
  const { error: drawInsertError } = await supabase.from('project_draws').insert({ job_id: id, draw_number: drawNum, status: 'draft', line_snapshot: JSON.stringify(items) });
  if (drawInsertError) {
    setFlash(req, 'error', 'Draw generation failed: ' + drawInsertError.message);
    return res.redirect('/projects/' + id);
  }
  for (const item of items) {
    if (item.current_billed > 0) {
      const { error: itemUpdateError } = await supabase.from('project_sov_items').update({
        previous_billed: Number(item.previous_billed) + Number(item.current_billed),
        current_billed: 0,
      }).eq('id', item.id);
      if (itemUpdateError) throw itemUpdateError;
    }
  }
  setFlash(req, 'success', 'Draw #' + drawNum + ' generated.');
  res.redirect('/projects/' + id);
});

// ---------- Decisions (D-024c) ----------

router.post('/:id/decisions', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'operations');
  if (!allowed) return;
  const decisionTypes = new Set(['rfi', 'submittal', 'field_decision']);
  const decisionType = decisionTypes.has(req.body.decision_type) ? req.body.decision_type : 'rfi';
  const question = String(req.body.question || '').trim();
  if (!question) {
    setFlash(req, 'error', 'Question / description is required.');
    return res.redirect('/projects/' + id);
  }
  // Normalize assigned_to to array (form submits checkboxes as assigned_to[])
  var assignedTo = [].concat(req.body.assigned_to || []).filter(Boolean).map(Number);
  var firstAssignee = assignedTo.length > 0 ? assignedTo[0] : null;

  const { data: newDecision, error } = await supabase.from('project_decisions').insert({
    job_id: parseInt(id, 10),
    decision_type: decisionType,
    question,
    status: 'pending',
    due_date: req.body.due_date || null,
    assigned_to_user_id: firstAssignee,
    created_by_user_id: req.session.userId || null,
  }).select('id').maybeSingle();
  if (error) throw error;

  // F-001: bulk-insert into decision_assignees for all selected users
  if (newDecision && assignedTo.length > 0) {
    var daRows = assignedTo.map(function(uid){
      return { decision_id: newDecision.id, user_id: uid, assigned_by_user_id: req.session.userId || null };
    });
    var { error: daError } = await supabase.from('decision_assignees').upsert(daRows, { onConflict: 'decision_id,user_id', ignoreDuplicates: true });
    if (daError) console.warn('[decisions] assignee insert failed:', daError.message);
  }
  setFlash(req, 'success', 'Decision item added.');
  res.redirect('/projects/' + id);
});

router.post('/:id/decisions/:dId/answer', async (req, res) => {
  const allowed = await requireProjectAccess(req, res, req.params.id, 'operations');
  if (!allowed) return;
  const statuses = new Set(['pending', 'open', 'answered', 'approved', 'rejected', 'closed']);
  const nextStatus = statuses.has(req.body.status) ? req.body.status : 'answered';
  const { error, count } = await supabase.from('project_decisions').update({
    answer: String(req.body.answer || '').trim() || null,
    status: nextStatus,
    answered_at: new Date(),
  }, { count: 'exact' }).eq('id', req.params.dId).eq('job_id', req.params.id);
  if (error) throw error;
  if (!count) {
    setFlash(req, 'error', 'Decision item not found.');
    return res.redirect('/projects/' + req.params.id);
  }
  setFlash(req, 'success', 'Decision updated.');
  res.redirect('/projects/' + req.params.id);
});

// ── Project Chat ────────────────────────────────────────────────────────

function projectChatPhotoMiddleware(req, res, next) {
  chatPhotoUpload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Photo upload failed.' });
    next();
  });
}

router.get('/:id/chat/photo-upload-url', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id);
  if (!allowed) return;

  const filename = String(req.query.filename || '').trim();
  const contentType = String(req.query.content_type || '').trim();
  const size = Number(req.query.size || 0);
  if (!filename) return res.status(400).json({ error: 'Filename is required.' });
  if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'Project chat attachments must be image files.' });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'File size is required.' });
  if (size > CHAT_PHOTO_MAX_SIZE) return res.status(413).json({ error: `Photos must be ${Math.round(CHAT_PHOTO_MAX_SIZE / 1024 / 1024)} MB or smaller.` });

  try {
    const key = projectChatPhotoKey(id, { originalname: filename });
    const signed = await storage.getUploadUrl(CHAT_PHOTO_BUCKET, key);
    return res.json({ ok: true, uploadUrl: signed.uploadUrl, storageKey: signed.storageKey });
  } catch (error) {
    return res.status(500).json({ error: 'Could not prepare photo upload: ' + error.message });
  }
});

router.post('/:id/chat', projectChatPhotoMiddleware, async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id);
  if (!allowed) return;
  const message = (req.body.message || '').trim();
  const photo = req.file || null;
  const uploadedPhotoKey = String(req.body.photo_storage_key || '').trim();
  const uploadedPhotoType = String(req.body.photo_mime_type || '').trim();
  const uploadedPhotoName = String(req.body.photo_original_name || '').trim();
  const uploadedPhotoSize = Number(req.body.photo_size_bytes || 0);
  if (!message && !photo && !uploadedPhotoKey) return res.status(400).json({ error: 'Message or photo is required.' });

  let attachment = {};
  try {
    if (photo) {
      const key = projectChatPhotoKey(id, photo);
      await storage.uploadBuffer(CHAT_PHOTO_BUCKET, key, photo.buffer, photo.mimetype);
      attachment = {
        attachment_bucket: CHAT_PHOTO_BUCKET,
        attachment_key: key,
        attachment_mime_type: photo.mimetype,
        attachment_original_name: photo.originalname || 'photo',
        attachment_size_bytes: photo.size || null,
      };
    } else if (uploadedPhotoKey) {
      if (!uploadedPhotoKey.startsWith(`project-chat/${id}/`) || uploadedPhotoKey.includes('..')) {
        return res.status(400).json({ error: 'Invalid uploaded photo key.' });
      }
      if (!uploadedPhotoType.startsWith('image/')) {
        return res.status(400).json({ error: 'Project chat attachments must be image files.' });
      }
      if (!Number.isFinite(uploadedPhotoSize) || uploadedPhotoSize <= 0 || uploadedPhotoSize > CHAT_PHOTO_MAX_SIZE) {
        return res.status(400).json({ error: 'Invalid uploaded photo size.' });
      }
      attachment = {
        attachment_bucket: CHAT_PHOTO_BUCKET,
        attachment_key: uploadedPhotoKey,
        attachment_mime_type: uploadedPhotoType,
        attachment_original_name: uploadedPhotoName || 'photo',
        attachment_size_bytes: uploadedPhotoSize,
      };
    }
  } catch (uploadError) {
    return res.status(500).json({ error: 'Photo upload failed: ' + uploadError.message });
  }

  const { data: msg, error } = await supabase.from('project_chat_messages').insert({
    job_id: parseInt(id, 10),
    user_id: req.session.userId,
    message,
    ...attachment,
  }).select('id, user_id, message, attachment_bucket, attachment_key, attachment_mime_type, attachment_original_name, attachment_size_bytes, created_at, users!inner(id, name, email)').single();
  if (error && attachment.attachment_key) {
    try { await storage.remove(CHAT_PHOTO_BUCKET, attachment.attachment_key); } catch (_) {}
  }
  if (error) return res.status(500).json({ error: error.message });
  const hydratedMsg = await hydrateProjectChatAttachment(msg);

  try {
    const explicitMentionIds = String(req.body.mention_user_ids || '')
      .split(',')
      .map(v => Number(v.trim()))
      .filter(Boolean);
    const [mentionUsers, projectResult] = await Promise.all([
      loadProjectMentionUsers(id),
      supabase.from('jobs').select('id, title').eq('id', id).maybeSingle(),
    ]);
    throwIfSupabaseError(projectResult, 'Project chat email project load failed');
    const mentionedIds = resolveMentionIds(message, mentionUsers, explicitMentionIds);
    const recipients = mentionUsers.filter(user =>
      mentionedIds.has(Number(user.id)) &&
      Number(user.id) !== Number(req.session.userId) &&
      user.email
    );
    await sendProjectChatMentionEmails({
      projectId: id,
      projectTitle: projectResult.data?.title,
      authorName: hydratedMsg.users?.name || req.session.name,
      message,
      recipients,
    });
  } catch (emailError) {
    console.warn('[project-chat] mention email processing failed:', emailError.message);
  }

  res.json({ ok: true, message: { ...hydratedMsg, seen_by: [] } });
});

router.get('/:id/chat', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id);
  if (!allowed) return;
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  let query = supabase
    .from('project_chat_messages')
    .select('id, user_id, message, attachment_bucket, attachment_key, attachment_mime_type, attachment_original_name, attachment_size_bytes, created_at, users!inner(id, name, email)')
    .eq('job_id', id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (before) query = query.lt('id', before);
  const { data: messages, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const rows = messages || [];
  await markProjectChatMessagesRead(rows, req.session.userId);
  const readsByMessage = await loadProjectChatReads(rows.map(message => message.id));
  const hydrated = await Promise.all(rows.reverse().map(hydrateProjectChatAttachment));
  res.json({ messages: attachProjectChatReads(hydrated, readsByMessage) });
});

// POST /:id/chat/:msgId/delete — delete a chat message (author or admin/manager)
router.post('/:id/chat/:msgId/delete', async (req, res) => {
  const id = req.params.id;
  const msgId = parseInt(req.params.msgId, 10);
  if (!msgId) return res.status(400).json({ error: 'Invalid message ID.' });
  const { data: msg, error: findError } = await supabase
    .from('project_chat_messages')
    .select('id, user_id, attachment_bucket, attachment_key')
    .eq('id', msgId)
    .eq('job_id', parseInt(id, 10))
    .maybeSingle();
  if (findError) return res.status(500).json({ error: findError.message });
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  // Only the author or admin/manager can delete
  const isAuthor = Number(msg.user_id) === Number(req.session.userId);
  const isPrivileged = req.session.role === 'admin' || req.session.role === 'manager';
  if (!isAuthor && !isPrivileged) return res.status(403).json({ error: 'You can only delete your own messages.' });
  if (msg.attachment_key) {
    try { await storage.remove(msg.attachment_bucket || CHAT_PHOTO_BUCKET, msg.attachment_key); } catch (e) { /* best effort */ }
  }
  const { error: deleteError } = await supabase
    .from('project_chat_messages')
    .delete()
    .eq('id', msgId);
  if (deleteError) return res.status(500).json({ error: deleteError.message });
  res.json({ ok: true });
});

// ---------- Excel export (D-024d) ----------

router.get('/:id/export.xlsx', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'billing');
  if (!allowed) return;
  const ExcelJS = require('exceljs');
  const { data: job, error: jobError } = await supabase.from('jobs').select('*, customers!left(name, email)').eq('id', id).maybeSingle();
  if (jobError) throw jobError;
  if (!job) return res.status(404).send('Project not found');
  const [woRes, membersRes, vendorsRes] = await Promise.all([
    supabase.from('work_orders').select('display_number, description, status, scheduled_date, unit_number').eq('job_id', id).order('created_at'),
    supabase.from('job_members').select('role, users!inner(name, email)').eq('job_id', id),
    supabase.from('project_contractors').select('contract_amount, vendors!left(name)').eq('job_id', id),
  ]);
  for (const result of [woRes, membersRes, vendorsRes]) {
    if (result.error) throw result.error;
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FORGE';
  const sh1 = wb.addWorksheet('Project');
  sh1.addRow(['Field', 'Value']);
  sh1.addRow(['Project', job.title]);
  sh1.addRow(['Customer', job.customers?.name || job.client || '']);
  sh1.addRow(['Contract Value', job.contract_value || 0]);
  const sh2 = wb.addWorksheet('Work Orders');
  sh2.addRow(['Display #', 'Description', 'Status', 'Scheduled', 'Unit']);
  (woRes.data || []).forEach(function(wo) { sh2.addRow([wo.display_number, wo.description, wo.status, wo.scheduled_date, wo.unit_number]); });
  const sh3 = wb.addWorksheet('Team');
  sh3.addRow(['Name', 'Email', 'Role']);
  (membersRes.data || []).forEach(function(m) { sh3.addRow([m.users?.name, m.users?.email, m.role]); });
  const sh4 = wb.addWorksheet('Vendors');
  sh4.addRow(['Vendor', 'Contract Amount']);
  (vendorsRes.data || []).forEach(function(v) { sh4.addRow([v.vendors?.name, v.contract_amount]); });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + id + '-export.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Members ----------

router.get('/:id/members', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  return renderMembersSection(res, id, allowed.access);
});

router.post('/:id/members', async (req, res) => {
  const id = req.params.id;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  const userId = parseInt(req.body.user_id, 10);
  const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'superintendent';
  const memberForm = { user_id: userId || req.body.user_id, role };
  if (!userId) {
    if (req.get('HX-Request')) {
      res.status(400);
      return renderMembersSection(res, id, allowed.access, {
        memberError: 'Choose a user before adding a project member.',
        memberForm,
      });
    }
    setFlash(req, 'error', 'Choose a user before adding a project member.');
    return res.redirect(`/projects/${id}`);
  }

  try {
    // UNIQUE(job_id, user_id) — if already a member, just update role.
    const { data: existing, error: existingMemberError } = await supabase
      .from('job_members')
      .select('id')
      .eq('job_id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (existingMemberError) throw existingMemberError;
    if (existing) {
      const { error } = await supabase.from('job_members').update({ role }).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('job_members').insert({
        job_id: parseInt(id, 10),
        user_id: userId,
        role,
      });
      if (error) throw error;
    }
  } catch (error) {
    const msg = error?.message || 'Project member could not be saved.';
    if (req.get('HX-Request')) {
      res.status(400);
      return renderMembersSection(res, id, allowed.access, {
        memberError: `Project member could not be saved: ${msg}`,
        memberForm,
      });
    }
    setFlash(req, 'error', `Project member could not be saved: ${msg}`);
    return res.redirect(`/projects/${id}`);
  }

  if (req.get('HX-Request')) {
    return renderMembersSection(res, id, allowed.access);
  }
  setFlash(req, 'success', 'Project member saved.');
  res.redirect(`/projects/${id}`);
});

router.delete('/:id/members/:memberId', async (req, res) => {
  const { id, memberId } = req.params;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  const { error } = await supabase
    .from('job_members')
    .delete()
    .eq('id', memberId)
    .eq('job_id', id);
  if (error) throw error;
  return renderMembersSection(res, id, allowed.access);
});

router.post('/:id/members/:memberId/delete', async (req, res) => {
  const { id, memberId } = req.params;
  const allowed = await requireProjectAccess(req, res, id, 'manage');
  if (!allowed) return;
  const { error } = await supabase
    .from('job_members')
    .delete()
    .eq('id', memberId)
    .eq('job_id', id);
  if (error) throw error;
  setFlash(req, 'success', 'Project member removed.');
  res.redirect(`/projects/${id}`);
});

module.exports = router;
module.exports.loadProjectAccess = loadProjectAccess;
module.exports.requireProjectAccess = requireProjectAccess;
module.exports.denyProjectAccess = denyProjectAccess;
