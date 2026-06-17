const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const { sendEmail } = require('../services/email');
const storage = require('../services/storage');
const { renderUniversalDocumentPdf } = require('../services/universal-document-pdf');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const ACTIVE_BLOCKING_STATUSES = ['not_started', 'required', 'generated', 'sent', 'returned', 'uploaded', 'rejected', 'expired'];

function emptyToNull(value) {
  if (typeof value !== 'string') return value || null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function boolFromBody(value) {
  return value === 'on' || value === 'true' || value === true;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function safeFilePart(value) {
  return slugify(value || 'document') || 'document';
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function getPathValue(obj, pathName) {
  return String(pathName || '').split('.').reduce((acc, key) => {
    if (acc === undefined || acc === null) return '';
    return acc[key];
  }, obj);
}

function mergeTemplate(body, context) {
  return String(body || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token) => {
    const value = getPathValue(context, token.trim());
    return value === undefined || value === null || value === '' ? '' : String(value);
  });
}

function parseMergeFields(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return String(value).split(/\r?\n|,/).map(v => v.trim()).filter(Boolean);
  }
}

function statusLabel(status) {
  const labels = {
    not_started: 'Not started',
    required: 'Required',
    generated: 'Generated',
    sent: 'Sent',
    returned: 'Returned',
    uploaded: 'Uploaded',
    complete: 'Approved / complete',
    completed: 'Approved / complete',
    rejected: 'Needs revision',
    expired: 'Expired',
    waived: 'Waived',
    draft: 'Draft',
    viewed: 'Viewed',
    signed: 'Signed',
    cancelled: 'Cancelled',
  };
  return labels[status] || status || '—';
}

async function logEvent({ generatedDocumentId = null, requirementId = null, eventType, note = null, metadata = {}, userId = null }) {
  const { error } = await supabase.from('document_events').insert({
    generated_document_id: generatedDocumentId,
    requirement_id: requirementId,
    event_type: eventType,
    note,
    metadata,
    created_by: userId,
  });
  if (error) console.warn('[universal-documents] event log failed:', error.message);
}

async function loadTemplate(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('universal_document_templates').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadProject(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from('jobs')
    .select('*, customers(name,email,phone,address,city,state,zip)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadContractor(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('contractors').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadVendor(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadRequirement(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('preconstruction_document_requirements').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadLists() {
  const [templatesResult, projectsResult, contractorsResult, vendorsResult, rfpsResult, typesResult] = await Promise.all([
    supabase.from('universal_document_templates').select('*').eq('is_active', true).order('category').order('title'),
    supabase.from('jobs').select('id,title,status,customer_id').order('created_at', { ascending: false }).limit(300),
    supabase.from('contractors').select('id,name,trade,email,phone').order('name').limit(500),
    supabase.from('vendors').select('id,name,email,phone').order('name').limit(500),
    supabase.from('project_rfps').select('id,job_id,contractor_name,status').order('created_at', { ascending: false }).limit(500),
    supabase.from('preconstruction_document_types').select('*').eq('is_active', true).order('sort_order'),
  ]);
  [templatesResult, projectsResult, contractorsResult, vendorsResult, rfpsResult, typesResult].forEach((result) => {
    if (result.error) throw result.error;
  });
  return {
    templates: templatesResult.data || [],
    projects: projectsResult.data || [],
    contractors: contractorsResult.data || [],
    vendors: vendorsResult.data || [],
    rfps: rfpsResult.data || [],
    documentTypes: typesResult.data || [],
  };
}

function buildMergeContext({ project, contractor, vendor, requirement, user, extra = {} }) {
  const customer = project?.customers || {};
  return {
    project: {
      id: project?.id || '',
      title: project?.title || '',
      address: [project?.address, project?.city, project?.state, project?.zip].filter(Boolean).join(', '),
      schedule: [project?.scheduled_date, project?.scheduled_time].filter(Boolean).join(' '),
      status: project?.status || '',
      description: project?.description || '',
      customer_name: customer.name || '',
    },
    contractor: {
      name: contractor?.name || requirement?.scope_name || '',
      email: contractor?.email || '',
      phone: contractor?.phone || '',
      trade: contractor?.trade || requirement?.trade || '',
      service_area: contractor?.service_area || '',
    },
    vendor: {
      name: vendor?.name || '',
      email: vendor?.email || '',
      phone: vendor?.phone || '',
    },
    customer,
    scope: {
      name: requirement?.scope_name || requirement?.trade || extra.scope_name || '',
    },
    contract: {
      amount: extra.contract_amount || '',
    },
    payment: {
      amount: extra.payment_amount || '',
      through_date: extra.payment_through_date || '',
    },
    internal: {
      notes: extra.internal_notes || '',
    },
    current: {
      date: new Date().toISOString().slice(0, 10),
      user: user?.name || '',
    },
  };
}

async function buildDocumentPayload({ template, project, contractor, vendor, requirement, body, user = null }) {
  const context = buildMergeContext({ project, contractor, vendor, requirement, user });
  const bodySnapshot = body || mergeTemplate(template.body, context);
  return { context, bodySnapshot };
}

async function uploadDocumentAttachment({ file, document = null, requirement = null, userId = null, attachmentType = 'signed_document' }) {
  if (!file) return null;
  const projectId = document?.project_id || requirement?.project_id || 'general';
  const contractorId = document?.contractor_id || requirement?.contractor_id || 'unassigned';
  const docType = safeFilePart(document?.document_type || document?.title || 'document');
  const ext = path.extname(file.originalname || '') || '';
  const key = `contractors/${contractorId}/projects/${projectId}/documents/${docType}/${crypto.randomUUID()}${ext}`;
  await storage.uploadBuffer('entity-files', key, file.buffer, file.mimetype || 'application/octet-stream');
  const { data, error } = await supabase.from('document_attachments').insert({
    generated_document_id: document?.id || null,
    requirement_id: requirement?.id || null,
    project_id: projectId === 'general' ? null : projectId,
    contractor_id: contractorId === 'unassigned' ? null : contractorId,
    vendor_id: document?.vendor_id || requirement?.vendor_id || null,
    storage_bucket: 'entity-files',
    storage_key: key,
    filename: file.originalname || path.basename(key),
    mime_type: file.mimetype,
    size_bytes: file.size,
    attachment_type: attachmentType,
    uploaded_by: userId,
  }).select('*').single();
  if (error) throw error;
  return data;
}

async function loadGeneratedDocument(id) {
  const { data, error } = await supabase.from('generated_documents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [template, project, contractor, vendor, requirement, attachmentsResult, eventsResult] = await Promise.all([
    loadTemplate(data.template_id),
    loadProject(data.project_id),
    loadContractor(data.contractor_id),
    loadVendor(data.vendor_id),
    loadRequirement(data.requirement_id),
    supabase.from('document_attachments').select('*').eq('generated_document_id', id).order('created_at', { ascending: false }),
    supabase.from('document_events').select('*, users(name,email)').eq('generated_document_id', id).order('created_at', { ascending: false }),
  ]);
  if (attachmentsResult.error) throw attachmentsResult.error;
  if (eventsResult.error) throw eventsResult.error;
  return { document: data, template, project, contractor, vendor, requirement, attachments: attachmentsResult.data || [], events: eventsResult.data || [] };
}

router.get('/', async (req, res) => {
  const [templatesResult, docsResult] = await Promise.all([
    supabase.from('universal_document_templates').select('*').order('category').order('title'),
    supabase.from('generated_documents').select('*').order('created_at', { ascending: false }).limit(25),
  ]);
  if (templatesResult.error) throw templatesResult.error;
  if (docsResult.error) throw docsResult.error;
  res.render('universal-documents/index', {
    title: 'Universal Documents',
    activeNav: 'documents',
    templates: templatesResult.data || [],
    documents: docsResult.data || [],
    statusLabel,
    formatDate,
  });
});

router.get('/templates/new', (req, res) => {
  res.render('universal-documents/template-form', {
    title: 'New document template',
    activeNav: 'documents',
    template: {},
    errors: {},
    mode: 'new',
  });
});

router.post('/templates', async (req, res) => {
  const title = emptyToNull(req.body.title);
  if (!title) {
    return res.status(422).render('universal-documents/template-form', {
      title: 'New document template',
      activeNav: 'documents',
      template: req.body,
      errors: { title: 'Title is required.' },
      mode: 'new',
    });
  }
  const { data, error } = await supabase.from('universal_document_templates').insert({
    title,
    slug: slugify(req.body.slug || title),
    category: emptyToNull(req.body.category) || 'general',
    description: emptyToNull(req.body.description),
    version: emptyToNull(req.body.version) || '1.0',
    is_active: boolFromBody(req.body.is_active),
    body: req.body.body || '',
    merge_fields: parseMergeFields(req.body.merge_fields),
    signature_required: boolFromBody(req.body.signature_required),
    internal_only: boolFromBody(req.body.internal_only),
    contractor_facing: boolFromBody(req.body.contractor_facing),
    project_facing: boolFromBody(req.body.project_facing),
    created_by: req.user?.id || null,
    updated_by: req.user?.id || null,
  }).select('id').single();
  if (error) throw error;
  setFlash(req, 'success', 'Template created.');
  res.redirect(`/universal-documents/templates/${data.id}/edit`);
});

router.get('/templates/:id/edit', async (req, res) => {
  const template = await loadTemplate(req.params.id);
  if (!template) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Template not found.' });
  res.render('universal-documents/template-form', { title: `Edit ${template.title}`, activeNav: 'documents', template, errors: {}, mode: 'edit' });
});

router.post('/templates/:id', async (req, res) => {
  const update = {
    title: emptyToNull(req.body.title),
    slug: slugify(req.body.slug || req.body.title),
    category: emptyToNull(req.body.category) || 'general',
    description: emptyToNull(req.body.description),
    version: emptyToNull(req.body.version) || '1.0',
    is_active: boolFromBody(req.body.is_active),
    body: req.body.body || '',
    merge_fields: parseMergeFields(req.body.merge_fields),
    signature_required: boolFromBody(req.body.signature_required),
    internal_only: boolFromBody(req.body.internal_only),
    contractor_facing: boolFromBody(req.body.contractor_facing),
    project_facing: boolFromBody(req.body.project_facing),
    updated_by: req.user?.id || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('universal_document_templates').update(update).eq('id', req.params.id);
  if (error) throw error;
  setFlash(req, 'success', 'Template updated.');
  res.redirect('/universal-documents');
});

router.get('/generate', async (req, res) => {
  const lists = await loadLists();
  res.render('universal-documents/generate', { title: 'Generate document', activeNav: 'documents', ...lists, values: req.query || {} });
});

router.post('/generate', async (req, res) => {
  const template = await loadTemplate(req.body.template_id);
  if (!template) throw new Error('Template is required.');
  const [project, contractor, vendor] = await Promise.all([
    loadProject(req.body.project_id),
    loadContractor(req.body.contractor_id),
    loadVendor(req.body.vendor_id),
  ]);
  const requirement = {
    scope_name: emptyToNull(req.body.scope_name),
    trade: emptyToNull(req.body.trade),
  };
  const { context, bodySnapshot } = await buildDocumentPayload({ template, project, contractor, vendor, requirement, user: req.user });
  const { data, error } = await supabase.from('generated_documents').insert({
    template_id: template.id,
    project_id: project?.id || null,
    contractor_id: contractor?.id || null,
    vendor_id: vendor?.id || null,
    project_rfp_id: emptyToNull(req.body.project_rfp_id),
    title: emptyToNull(req.body.title) || template.title,
    status: 'generated',
    scope_name: requirement.scope_name || requirement.trade,
    sent_to_email: emptyToNull(req.body.sent_to_email) || contractor?.email || vendor?.email || null,
    body_snapshot: bodySnapshot,
    merge_data: context,
    created_by: req.user?.id || null,
    updated_by: req.user?.id || null,
  }).select('*').single();
  if (error) throw error;
  await logEvent({ generatedDocumentId: data.id, eventType: 'generated', userId: req.user?.id || null });
  res.redirect(`/universal-documents/generated/${data.id}`);
});

router.get('/generated/:id', async (req, res) => {
  const loaded = await loadGeneratedDocument(req.params.id);
  if (!loaded) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Document not found.' });
  res.render('universal-documents/preview', { title: loaded.document.title, activeNav: 'documents', ...loaded, statusLabel, formatDate });
});

router.get('/generated/:id/pdf', async (req, res) => {
  const loaded = await loadGeneratedDocument(req.params.id);
  if (!loaded) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Document not found.' });
  const buffer = await renderUniversalDocumentPdf(loaded);
  const filename = `${safeFilePart(loaded.document.title)}-${loaded.document.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
});

router.post('/generated/:id/email', async (req, res) => {
  const loaded = await loadGeneratedDocument(req.params.id);
  if (!loaded) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Document not found.' });
  const to = emptyToNull(req.body.sent_to_email) || loaded.document.sent_to_email;
  if (!to) {
    setFlash(req, 'error', 'Recipient email is required.');
    return res.redirect(`/universal-documents/generated/${req.params.id}`);
  }
  const buffer = await renderUniversalDocumentPdf(loaded);
  await sendEmail({
    to,
    subject: `FORGE document: ${loaded.document.title}`,
    htmlBody: `<p>Please review the attached document for ${loaded.project?.title || 'the project'}.</p>`,
    attachments: [{ filename: `${safeFilePart(loaded.document.title)}.pdf`, content: buffer, contentType: 'application/pdf' }],
  });
  const now = new Date().toISOString();
  const { error } = await supabase.from('generated_documents').update({
    status: 'sent',
    sent_to_email: to,
    sent_at: now,
    updated_by: req.user?.id || null,
    updated_at: now,
  }).eq('id', req.params.id);
  if (error) throw error;
  if (loaded.requirement?.id) {
    await supabase.from('preconstruction_document_requirements').update({ status: 'sent', sent_at: now, updated_by: req.user?.id || null, updated_at: now }).eq('id', loaded.requirement.id);
  }
  await logEvent({ generatedDocumentId: loaded.document.id, requirementId: loaded.requirement?.id || null, eventType: 'sent', note: `Sent to ${to}`, userId: req.user?.id || null });
  setFlash(req, 'success', 'Document emailed.');
  res.redirect(`/universal-documents/generated/${req.params.id}`);
});

router.post('/generated/:id/status', async (req, res) => {
  const status = emptyToNull(req.body.status);
  const now = new Date().toISOString();
  const update = { status, updated_by: req.user?.id || null, updated_at: now };
  if (status === 'signed') update.signed_at = now;
  if (status === 'completed') update.completed_at = now;
  const { error } = await supabase.from('generated_documents').update(update).eq('id', req.params.id);
  if (error) throw error;
  await logEvent({ generatedDocumentId: req.params.id, eventType: `status_${status}`, note: emptyToNull(req.body.note), userId: req.user?.id || null });
  setFlash(req, 'success', 'Document status updated.');
  res.redirect(`/universal-documents/generated/${req.params.id}`);
});

router.post('/generated/:id/upload-signed', upload.single('signed_file'), async (req, res) => {
  const loaded = await loadGeneratedDocument(req.params.id);
  if (!loaded || !req.file) {
    setFlash(req, 'error', 'Choose a signed document to upload.');
    return res.redirect(`/universal-documents/generated/${req.params.id}`);
  }
  const attachment = await uploadDocumentAttachment({ file: req.file, document: loaded.document, requirement: loaded.requirement, userId: req.user?.id || null });
  const now = new Date().toISOString();
  await supabase.from('generated_documents').update({ status: 'signed', signed_at: now, updated_at: now, updated_by: req.user?.id || null }).eq('id', loaded.document.id);
  if (loaded.requirement?.id) {
    await supabase.from('preconstruction_document_requirements').update({ status: 'uploaded', uploaded_at: now, returned_at: now, updated_at: now, updated_by: req.user?.id || null }).eq('id', loaded.requirement.id);
  }
  await logEvent({ generatedDocumentId: loaded.document.id, requirementId: loaded.requirement?.id || null, eventType: 'uploaded', note: attachment.filename, userId: req.user?.id || null });
  setFlash(req, 'success', 'Signed document uploaded.');
  res.redirect(`/universal-documents/generated/${req.params.id}`);
});

async function seedDefaultRequirements(projectId, userId) {
  const [typesResult, rfpsResult, existingResult] = await Promise.all([
    supabase.from('preconstruction_document_types').select('*').eq('default_required', true).eq('is_active', true),
    supabase.from('project_rfps').select('id,contractor_name,status,job_id').eq('job_id', projectId),
    supabase.from('preconstruction_document_requirements').select('project_rfp_id,document_type_id').eq('project_id', projectId),
  ]);
  if (typesResult.error) throw typesResult.error;
  if (rfpsResult.error) throw rfpsResult.error;
  if (existingResult.error) throw existingResult.error;
  const existing = new Set((existingResult.data || []).map(r => `${r.project_rfp_id || ''}:${r.document_type_id || ''}`));
  const inserts = [];
  (rfpsResult.data || []).forEach((rfp) => {
    (typesResult.data || []).forEach((type) => {
      const key = `${rfp.id}:${type.id}`;
      if (!existing.has(key)) {
        inserts.push({
          project_id: projectId,
          project_rfp_id: rfp.id,
          document_type_id: type.id,
          scope_name: rfp.contractor_name,
          trade: rfp.contractor_name,
          status: 'required',
          created_by: userId,
          updated_by: userId,
        });
      }
    });
  });
  if (inserts.length) {
    const { error } = await supabase.from('preconstruction_document_requirements').insert(inserts);
    if (error) throw error;
  }
}

router.get('/preconstruction/projects/:projectId', async (req, res) => {
  const projectId = Number(req.params.projectId);
  await seedDefaultRequirements(projectId, req.user?.id || null);
  const [project, lists, requirementsResult, eventsResult] = await Promise.all([
    loadProject(projectId),
    loadLists(),
    supabase.from('preconstruction_document_requirements')
      .select('*, preconstruction_document_types(name,slug), contractors(name,email), vendors(name,email), generated_documents!pdr_generated_doc_fkey(title,status,sent_to_email)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase.from('scope_release_logs').select('*, users(name,email)').eq('project_id', projectId).order('created_at', { ascending: false }).limit(20),
  ]);
  if (requirementsResult.error) throw requirementsResult.error;
  if (eventsResult.error) throw eventsResult.error;
  res.render('universal-documents/preconstruction', {
    title: `Pre-con docs - ${project?.title || 'Project'}`,
    activeNav: 'documents',
    project,
    ...lists,
    requirements: requirementsResult.data || [],
    releaseLogs: eventsResult.data || [],
    statusLabel,
    formatDate,
  });
});

router.post('/preconstruction/projects/:projectId/requirements', async (req, res) => {
  const { error } = await supabase.from('preconstruction_document_requirements').insert({
    project_id: req.params.projectId,
    contractor_id: emptyToNull(req.body.contractor_id),
    vendor_id: emptyToNull(req.body.vendor_id),
    project_rfp_id: emptyToNull(req.body.project_rfp_id),
    document_type_id: emptyToNull(req.body.document_type_id),
    scope_name: emptyToNull(req.body.scope_name),
    trade: emptyToNull(req.body.trade),
    status: 'required',
    due_date: emptyToNull(req.body.due_date),
    notes: emptyToNull(req.body.notes),
    created_by: req.user?.id || null,
    updated_by: req.user?.id || null,
  });
  if (error) throw error;
  setFlash(req, 'success', 'Requirement added.');
  res.redirect(`/universal-documents/preconstruction/projects/${req.params.projectId}`);
});

router.post('/preconstruction/requirements/:id/generate', async (req, res) => {
  const requirement = await loadRequirement(req.params.id);
  if (!requirement) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Requirement not found.' });
  const [typeResult, project, contractor, vendor] = await Promise.all([
    supabase.from('preconstruction_document_types').select('*').eq('id', requirement.document_type_id).maybeSingle(),
    loadProject(requirement.project_id),
    loadContractor(requirement.contractor_id),
    loadVendor(requirement.vendor_id),
  ]);
  if (typeResult.error) throw typeResult.error;
  const type = typeResult.data || {};
  const template = await loadTemplate(type.default_template_id);
  if (!template) throw new Error('No template is linked to this document type.');
  const { context, bodySnapshot } = await buildDocumentPayload({ template, project, contractor, vendor, requirement, user: req.user });
  const { data, error } = await supabase.from('generated_documents').insert({
    template_id: template.id,
    requirement_id: requirement.id,
    project_id: requirement.project_id,
    contractor_id: requirement.contractor_id,
    vendor_id: requirement.vendor_id,
    project_rfp_id: requirement.project_rfp_id,
    title: type.name || template.title,
    status: 'generated',
    scope_name: requirement.scope_name || requirement.trade,
    sent_to_email: contractor?.email || vendor?.email || null,
    body_snapshot: bodySnapshot,
    merge_data: context,
    created_by: req.user?.id || null,
    updated_by: req.user?.id || null,
  }).select('*').single();
  if (error) throw error;
  const now = new Date().toISOString();
  await supabase.from('preconstruction_document_requirements').update({
    generated_document_id: data.id,
    status: 'generated',
    updated_by: req.user?.id || null,
    updated_at: now,
  }).eq('id', requirement.id);
  await logEvent({ generatedDocumentId: data.id, requirementId: requirement.id, eventType: 'generated', userId: req.user?.id || null });
  res.redirect(`/universal-documents/generated/${data.id}`);
});

router.post('/preconstruction/requirements/:id/upload', upload.single('requirement_file'), async (req, res) => {
  const requirement = await loadRequirement(req.params.id);
  if (!requirement || !req.file) {
    setFlash(req, 'error', 'Choose a file to upload.');
    return res.redirect(req.get('referer') || '/universal-documents');
  }
  const doc = requirement.generated_document_id ? (await loadGeneratedDocument(requirement.generated_document_id))?.document : null;
  const attachment = await uploadDocumentAttachment({ file: req.file, document: doc, requirement, userId: req.user?.id || null });
  const now = new Date().toISOString();
  await supabase.from('preconstruction_document_requirements').update({ status: 'uploaded', uploaded_at: now, returned_at: now, updated_at: now, updated_by: req.user?.id || null }).eq('id', requirement.id);
  await logEvent({ generatedDocumentId: doc?.id || null, requirementId: requirement.id, eventType: 'uploaded', note: attachment.filename, userId: req.user?.id || null });
  setFlash(req, 'success', 'Document uploaded.');
  res.redirect(`/universal-documents/preconstruction/projects/${requirement.project_id}`);
});

router.post('/preconstruction/requirements/:id/complete', async (req, res) => {
  const requirement = await loadRequirement(req.params.id);
  if (!requirement) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Requirement not found.' });
  const now = new Date().toISOString();
  await supabase.from('preconstruction_document_requirements').update({ status: 'complete', completed_at: now, updated_at: now, updated_by: req.user?.id || null }).eq('id', requirement.id);
  if (requirement.generated_document_id) {
    await supabase.from('generated_documents').update({ status: 'completed', completed_at: now, updated_at: now, updated_by: req.user?.id || null }).eq('id', requirement.generated_document_id);
  }
  await logEvent({ generatedDocumentId: requirement.generated_document_id, requirementId: requirement.id, eventType: 'complete', userId: req.user?.id || null });
  res.redirect(`/universal-documents/preconstruction/projects/${requirement.project_id}`);
});

router.post('/preconstruction/requirements/:id/reject', async (req, res) => {
  const requirement = await loadRequirement(req.params.id);
  if (!requirement) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Requirement not found.' });
  const reason = emptyToNull(req.body.rejection_reason) || 'Needs revision';
  await supabase.from('preconstruction_document_requirements').update({ status: 'rejected', rejection_reason: reason, updated_at: new Date().toISOString(), updated_by: req.user?.id || null }).eq('id', requirement.id);
  await logEvent({ generatedDocumentId: requirement.generated_document_id, requirementId: requirement.id, eventType: 'rejected', note: reason, userId: req.user?.id || null });
  res.redirect(`/universal-documents/preconstruction/projects/${requirement.project_id}`);
});

router.post('/preconstruction/requirements/:id/waive', async (req, res) => {
  const requirement = await loadRequirement(req.params.id);
  if (!requirement) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Requirement not found.' });
  const reason = emptyToNull(req.body.waiver_reason);
  if (!reason) {
    setFlash(req, 'error', 'Waiver reason is required.');
    return res.redirect(`/universal-documents/preconstruction/projects/${requirement.project_id}`);
  }
  const now = new Date().toISOString();
  await supabase.from('preconstruction_document_requirements').update({ status: 'waived', waived_at: now, waiver_reason: reason, updated_at: now, updated_by: req.user?.id || null }).eq('id', requirement.id);
  await logEvent({ generatedDocumentId: requirement.generated_document_id, requirementId: requirement.id, eventType: 'waived', note: reason, userId: req.user?.id || null });
  res.redirect(`/universal-documents/preconstruction/projects/${requirement.project_id}`);
});

router.post('/preconstruction/projects/:projectId/release-scope', async (req, res) => {
  const projectId = Number(req.params.projectId);
  const { data: requirements, error } = await supabase
    .from('preconstruction_document_requirements')
    .select('*, preconstruction_document_types(name)')
    .eq('project_id', projectId)
    .in('status', ACTIVE_BLOCKING_STATUSES);
  if (error) throw error;
  const missing = (requirements || []).map(r => ({
    id: r.id,
    document: r.preconstruction_document_types?.name || r.scope_name || 'Requirement',
    scope: r.scope_name,
    status: r.status,
  }));
  const released = missing.length === 0;
  const { error: logError } = await supabase.from('scope_release_logs').insert({
    project_id: projectId,
    status: released ? 'released' : 'blocked',
    note: emptyToNull(req.body.note),
    missing_requirements: missing,
    created_by: req.user?.id || null,
  });
  if (logError) throw logError;
  setFlash(req, released ? 'success' : 'error', released ? 'Scope release logged.' : 'Scope release blocked. Complete or waive required documents first.');
  res.redirect(`/universal-documents/preconstruction/projects/${projectId}`);
});

module.exports = router;
