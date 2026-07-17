const express = require('express');
const crypto = require('crypto');
const supabase = require('../db/supabase');
const storage = require('../services/storage');
const { setFlash } = require('../middleware/auth');
const { loadProjectAccess, denyProjectAccess } = require('./jobs');
const { buildSubmittalPacket, pageCount } = require('../services/submittal-packet-pdf');
const { extractSubmittalMetadata, fillBlankMetadata, filenameTitle } = require('../services/submittal-spec-extractor');

const router = express.Router();
const BUCKET = 'entity-files';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_PACKET_SIZE = 100 * 1024 * 1024;
const MAX_FILES_PER_ITEM = 10;

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function safeFilename(value) {
  const name = text(value, 180).replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ');
  return name || 'product-spec.pdf';
}

function slug(value) {
  return text(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function throwResult(result, label) {
  if (result.error) {
    result.error.message = `${label}: ${result.error.message}`;
    throw result.error;
  }
  return result.data;
}

async function loadJob(jobId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*, customers!left(id, name, email, phone, address, city, state, zip)')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...data,
    customer_name: data.customers?.name || null,
    customer_email: data.customers?.email || null,
    customer_phone: data.customers?.phone || null,
  };
}

async function requireSubmittalAccess(req, res, next) {
  try {
    const job = await loadJob(req.params.id);
    if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });
    const access = await loadProjectAccess(req, job);
    if (!access.canSeeOperations) return denyProjectAccess(res, 'You do not have access to project submittals.');
    req.submittalJob = job;
    req.submittalAccess = access;
    next();
  } catch (error) {
    next(error);
  }
}

async function ensurePacket(job, userId, preparedBy) {
  const existing = throwResult(await supabase
    .from('project_submittal_packets')
    .select('*')
    .eq('job_id', job.id)
    .maybeSingle(), 'Submittal packet load failed');
  if (existing) return existing;
  return throwResult(await supabase
    .from('project_submittal_packets')
    .insert({
      job_id: job.id,
      packet_title: 'Product Submittal Package',
      prepared_for: job.customer_name || null,
      prepared_by: preparedBy || 'Recon Enterprises',
      issue_date: today(),
      created_by_user_id: userId || null,
      updated_by_user_id: userId || null,
    })
    .select()
    .single(), 'Submittal packet create failed');
}

async function loadItems(packetId) {
  const items = throwResult(await supabase
    .from('project_submittal_items')
    .select('*')
    .eq('packet_id', packetId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true }), 'Submittal items load failed') || [];
  if (!items.length) return [];
  const files = throwResult(await supabase
    .from('project_submittal_files')
    .select('*')
    .in('item_id', items.map(item => item.id))
    .order('id', { ascending: true }), 'Submittal files load failed') || [];
  const filesByItem = new Map();
  files.forEach(file => {
    const list = filesByItem.get(String(file.item_id)) || [];
    list.push(file);
    filesByItem.set(String(file.item_id), list);
  });
  return items.map(item => ({ ...item, files: filesByItem.get(String(item.id)) || [] }));
}

async function nextSortOrder(packetId) {
  const { data, error } = await supabase
    .from('project_submittal_items')
    .select('sort_order')
    .eq('packet_id', packetId)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (error) throw error;
  return Number(data?.[0]?.sort_order || 0) + 10;
}

function validateUploadDescriptor(jobId, file) {
  const storageKey = text(file.storage_key, 500);
  const fileName = safeFilename(file.file_name);
  const sizeBytes = Number(file.size_bytes || 0);
  if (!storageKey.startsWith(`project-submittals/${jobId}/`)) throw new Error('Invalid submittal storage key.');
  if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error('Product specs must be PDF files.');
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_SIZE) throw new Error('Invalid product spec file size.');
  return { storageKey, fileName, sizeBytes };
}

async function inspectUploadedPdf(jobId, file) {
  const valid = validateUploadDescriptor(jobId, file);
  const buffer = await storage.downloadBuffer(BUCKET, valid.storageKey);
  if (buffer.length > MAX_FILE_SIZE || buffer.subarray(0, 5).toString() !== '%PDF-') {
    await storage.remove(BUCKET, valid.storageKey).catch(() => {});
    throw new Error(`${valid.fileName} is not a valid PDF.`);
  }
  let pages;
  try {
    pages = await pageCount(buffer);
  } catch (error) {
    await storage.remove(BUCKET, valid.storageKey).catch(() => {});
    throw new Error(`${valid.fileName} could not be opened as a PDF.`);
  }
  return { ...valid, pageCount: pages, buffer };
}

function extractionFlash(extraction, action) {
  if (extraction.source === 'document') return `${action} Forge filled the available details from the product spec.`;
  return `${action} The product spec was saved, but its details could not be read automatically.`;
}

async function removeItemFiles(items) {
  const files = items.flatMap(item => item.files || []);
  await Promise.all(files.map(file => storage.remove(file.storage_bucket || BUCKET, file.storage_key).catch(error => {
    console.warn('[submittals] storage cleanup failed:', error.message);
  })));
}

router.get('/:id/submittals', requireSubmittalAccess, async (req, res, next) => {
  try {
    const preparedBy = res.locals.currentUser?.name || 'Recon Enterprises';
    const packet = await ensurePacket(req.submittalJob, req.session.userId, preparedBy);
    const items = await loadItems(packet.id);
    const sourcePackets = throwResult(await supabase
      .from('project_submittal_packets')
      .select('job_id, packet_title, updated_at, jobs!inner(id, title)')
      .neq('job_id', req.submittalJob.id)
      .order('updated_at', { ascending: false }), 'Import source load failed') || [];

    res.render('jobs/submittals', {
      title: `Submittals - ${req.submittalJob.title}`,
      activeNav: 'projects',
      currentUser: res.locals.currentUser,
      flash: res.locals.flash,
      job: req.submittalJob,
      access: req.submittalAccess,
      packet,
      items,
      sourcePackets: sourcePackets.map(source => ({ ...source, project_title: source.jobs?.title || `Project ${source.job_id}` })),
      maxFileSizeMb: Math.round(MAX_FILE_SIZE / 1024 / 1024),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submittals/packet', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    throwResult(await supabase
      .from('project_submittal_packets')
      .update({
        packet_title: text(req.body.packet_title, 180) || 'Product Submittal Package',
        prepared_for: text(req.body.prepared_for, 180) || null,
        prepared_by: text(req.body.prepared_by, 180) || null,
        revision: text(req.body.revision, 80) || null,
        issue_date: /^\d{4}-\d{2}-\d{2}$/.test(req.body.issue_date || '') ? req.body.issue_date : null,
        cover_notes: text(req.body.cover_notes, 3000) || null,
        updated_by_user_id: req.session.userId || null,
      })
      .eq('id', packet.id), 'Submittal packet update failed');
    setFlash(req, 'success', 'Submittal packet details saved.');
    res.redirect(`/projects/${req.params.id}/submittals`);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/submittals/upload-url', requireSubmittalAccess, async (req, res) => {
  try {
    const fileName = safeFilename(req.query.name);
    const sizeBytes = Number(req.query.size || 0);
    const mimeType = text(req.query.type, 120).toLowerCase();
    if (!fileName.toLowerCase().endsWith('.pdf') || (mimeType && mimeType !== 'application/pdf')) {
      return res.status(400).json({ error: 'Product specs must be PDF files.' });
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_SIZE) {
      return res.status(400).json({ error: `Each product spec must be ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB or smaller.` });
    }
    const key = `project-submittals/${req.params.id}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
    res.json(await storage.getUploadUrl(BUCKET, key));
  } catch (error) {
    console.error('[submittals] upload URL failed:', error);
    res.status(500).json({ error: 'Could not prepare the product spec upload.' });
  }
});

router.post('/:id/submittals/items', requireSubmittalAccess, express.json({ limit: '1mb' }), async (req, res) => {
  const uploadedKeys = [];
  let createdItemId = null;
  try {
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, MAX_FILES_PER_ITEM) : [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one product-spec PDF.' });
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const inspectedFiles = [];
    for (const file of files) {
      const inspected = await inspectUploadedPdf(req.params.id, file);
      inspectedFiles.push(inspected);
      uploadedKeys.push(inspected.storageKey);
    }
    const extraction = await extractSubmittalMetadata({ files: inspectedFiles, userId: req.session.userId });
    const metadata = fillBlankMetadata(req.body, extraction.data);
    const item = throwResult(await supabase
      .from('project_submittal_items')
      .insert({
        packet_id: packet.id,
        section_number: metadata.section_number || null,
        title: metadata.title,
        manufacturer: metadata.manufacturer || null,
        product_name: metadata.product_name || null,
        model_number: metadata.model_number || null,
        notes: metadata.notes || null,
        sort_order: await nextSortOrder(packet.id),
        created_by_user_id: req.session.userId || null,
      })
      .select()
      .single(), 'Submittal item create failed');
    createdItemId = item.id;
    throwResult(await supabase.from('project_submittal_files').insert(inspectedFiles.map(file => ({
      item_id: item.id,
      file_name: file.fileName,
      storage_bucket: BUCKET,
      storage_key: file.storageKey,
      mime_type: 'application/pdf',
      size_bytes: file.sizeBytes,
      page_count: file.pageCount,
      created_by_user_id: req.session.userId || null,
    }))), 'Submittal file registration failed');
    setFlash(req, 'success', extractionFlash(extraction, 'Submittal saved.'));
    res.json({ ok: true, item_id: item.id, auto_fill_source: extraction.source });
  } catch (error) {
    if (createdItemId) await supabase.from('project_submittal_items').delete().eq('id', createdItemId);
    await Promise.all(uploadedKeys.map(key => storage.remove(BUCKET, key).catch(() => {})));
    console.error('[submittals] item create failed:', error);
    res.status(500).json({ error: error.message || 'Could not save the submittal.' });
  }
});

router.post('/:id/submittals/items/:itemId', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const title = text(req.body.title, 240);
    if (!title) {
      setFlash(req, 'error', 'Submittal title is required.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    const updated = throwResult(await supabase
      .from('project_submittal_items')
      .update({
        section_number: text(req.body.section_number, 80) || null,
        title,
        manufacturer: text(req.body.manufacturer, 180) || null,
        product_name: text(req.body.product_name, 180) || null,
        model_number: text(req.body.model_number, 180) || null,
        notes: text(req.body.notes, 3000) || null,
      })
      .eq('id', req.params.itemId)
      .eq('packet_id', packet.id)
      .select('id'), 'Submittal item update failed');
    if (!updated?.length) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Submittal not found.' });
    setFlash(req, 'success', 'Submittal updated.');
    res.redirect(`/projects/${req.params.id}/submittals#submittal-${req.params.itemId}`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submittals/items/:itemId/files', requireSubmittalAccess, express.json({ limit: '1mb' }), async (req, res) => {
  const uploadedKeys = [];
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const item = throwResult(await supabase.from('project_submittal_items')
      .select('id, section_number, title, manufacturer, product_name, model_number, notes')
      .eq('id', req.params.itemId)
      .eq('packet_id', packet.id)
      .maybeSingle(), 'Submittal item load failed');
    if (!item) return res.status(404).json({ error: 'Submittal not found.' });
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, MAX_FILES_PER_ITEM) : [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one PDF.' });
    const inspected = [];
    for (const file of files) {
      const valid = await inspectUploadedPdf(req.params.id, file);
      inspected.push(valid);
      uploadedKeys.push(valid.storageKey);
    }
    const extraction = await extractSubmittalMetadata({ files: inspected, userId: req.session.userId });
    const metadata = fillBlankMetadata(item, extraction.data);
    throwResult(await supabase.from('project_submittal_items').update({
      section_number: metadata.section_number || null,
      title: metadata.title,
      manufacturer: metadata.manufacturer || null,
      product_name: metadata.product_name || null,
      model_number: metadata.model_number || null,
      notes: metadata.notes || null,
    }).eq('id', item.id).eq('packet_id', packet.id), 'Submittal auto-fill update failed');
    throwResult(await supabase.from('project_submittal_files').insert(inspected.map(file => ({
      item_id: item.id,
      file_name: file.fileName,
      storage_bucket: BUCKET,
      storage_key: file.storageKey,
      mime_type: 'application/pdf',
      size_bytes: file.sizeBytes,
      page_count: file.pageCount,
      created_by_user_id: req.session.userId || null,
    }))), 'Submittal file registration failed');
    setFlash(req, 'success', extractionFlash(extraction, 'Product spec added.'));
    res.json({ ok: true, auto_fill_source: extraction.source });
  } catch (error) {
    await Promise.all(uploadedKeys.map(key => storage.remove(BUCKET, key).catch(() => {})));
    console.error('[submittals] attachment add failed:', error);
    res.status(500).json({ error: error.message || 'Could not add the product spec.' });
  }
});

router.post('/:id/submittals/items/:itemId/analyze', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const items = await loadItems(packet.id);
    const item = items.find(row => String(row.id) === String(req.params.itemId));
    if (!item) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Submittal not found.' });
    if (!item.files.length) {
      setFlash(req, 'error', 'Attach a product-spec PDF before filling the details.');
      return res.redirect(`/projects/${req.params.id}/submittals#submittal-${item.id}`);
    }

    const files = [];
    for (const file of item.files.slice(0, 3)) {
      files.push({
        fileName: file.file_name,
        buffer: await storage.downloadBuffer(file.storage_bucket || BUCKET, file.storage_key),
      });
    }
    const extraction = await extractSubmittalMetadata({ files, userId: req.session.userId });
    if (extraction.source !== 'document') {
      setFlash(req, 'error', 'Forge could not identify product details in the attached PDF. You can still enter them manually.');
      return res.redirect(`/projects/${req.params.id}/submittals#submittal-${item.id}`);
    }

    const current = { ...item };
    const generatedTitles = item.files.map(file => filenameTitle(file.file_name).toLowerCase());
    if (generatedTitles.includes(text(item.title, 240).toLowerCase())) current.title = '';
    const metadata = fillBlankMetadata(current, extraction.data);
    const fields = ['section_number', 'title', 'manufacturer', 'product_name', 'model_number', 'notes'];
    const filledCount = fields.filter(field => text(item[field], 3000) !== metadata[field]).length;
    throwResult(await supabase.from('project_submittal_items').update({
      section_number: metadata.section_number || null,
      title: metadata.title,
      manufacturer: metadata.manufacturer || null,
      product_name: metadata.product_name || null,
      model_number: metadata.model_number || null,
      notes: metadata.notes || null,
    }).eq('id', item.id).eq('packet_id', packet.id), 'Submittal auto-fill update failed');
    setFlash(req, 'success', filledCount
      ? `Forge filled ${filledCount} product detail${filledCount === 1 ? '' : 's'} from the attached PDF.`
      : 'Forge analyzed the PDF. Existing product details were kept.');
    res.redirect(`/projects/${req.params.id}/submittals#submittal-${item.id}`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submittals/items/:itemId/move', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const items = await loadItems(packet.id);
    const index = items.findIndex(item => String(item.id) === String(req.params.itemId));
    const targetIndex = req.body.direction === 'up' ? index - 1 : index + 1;
    if (index >= 0 && targetIndex >= 0 && targetIndex < items.length) {
      const first = items[index];
      const second = items[targetIndex];
      throwResult(await supabase.from('project_submittal_items').update({ sort_order: second.sort_order }).eq('id', first.id), 'Submittal reorder failed');
      throwResult(await supabase.from('project_submittal_items').update({ sort_order: first.sort_order }).eq('id', second.id), 'Submittal reorder failed');
    }
    res.redirect(`/projects/${req.params.id}/submittals#submittal-${req.params.itemId}`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submittals/items/:itemId/delete', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const items = await loadItems(packet.id);
    const item = items.find(row => String(row.id) === String(req.params.itemId));
    if (!item) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Submittal not found.' });
    throwResult(await supabase.from('project_submittal_items').delete().eq('id', item.id).eq('packet_id', packet.id), 'Submittal delete failed');
    await removeItemFiles([item]);
    setFlash(req, 'success', 'Submittal removed.');
    res.redirect(`/projects/${req.params.id}/submittals`);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submittals/files/:fileId/delete', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const file = throwResult(await supabase
      .from('project_submittal_files')
      .select('*, project_submittal_items!inner(packet_id)')
      .eq('id', req.params.fileId)
      .eq('project_submittal_items.packet_id', packet.id)
      .maybeSingle(), 'Submittal file load failed');
    if (!file) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Product spec not found.' });
    throwResult(await supabase.from('project_submittal_files').delete().eq('id', file.id), 'Submittal file delete failed');
    await storage.remove(file.storage_bucket || BUCKET, file.storage_key).catch(error => {
      console.warn('[submittals] deleted file storage cleanup failed:', error.message);
    });
    setFlash(req, 'success', 'Product spec removed.');
    res.redirect(`/projects/${req.params.id}/submittals#submittal-${file.item_id}`);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/submittals/files/:fileId', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const file = throwResult(await supabase
      .from('project_submittal_files')
      .select('*, project_submittal_items!inner(packet_id)')
      .eq('id', req.params.fileId)
      .eq('project_submittal_items.packet_id', packet.id)
      .maybeSingle(), 'Submittal file load failed');
    if (!file) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Product spec not found.' });
    res.redirect(await storage.getSignedUrl(file.storage_bucket || BUCKET, file.storage_key, 900));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submittals/import', requireSubmittalAccess, async (req, res, next) => {
  try {
    const sourceJobId = Number(req.body.source_job_id);
    if (!sourceJobId || sourceJobId === Number(req.params.id)) {
      setFlash(req, 'error', 'Choose a different source project.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    const sourceJob = await loadJob(sourceJobId);
    if (!sourceJob) {
      setFlash(req, 'error', 'The source project could not be found.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    const sourceAccess = await loadProjectAccess(req, sourceJob);
    if (!sourceAccess.canSeeOperations) return denyProjectAccess(res, 'You do not have access to the source project.');
    const sourcePacket = throwResult(await supabase.from('project_submittal_packets').select('*').eq('job_id', sourceJobId).maybeSingle(), 'Source packet load failed');
    if (!sourcePacket) {
      setFlash(req, 'error', 'That project does not have a submittal packet yet.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    const sourceItems = await loadItems(sourcePacket.id);
    if (!sourceItems.length) {
      setFlash(req, 'error', 'That project does not have any submittals to import.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    const totalBytes = sourceItems.flatMap(item => item.files).reduce((sum, file) => sum + Number(file.size_bytes || 0), 0);
    if (totalBytes > MAX_PACKET_SIZE) throw new Error('The source packet is too large to import in one operation.');

    const targetPacket = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    if (req.body.import_mode === 'replace') {
      const targetItems = await loadItems(targetPacket.id);
      throwResult(await supabase.from('project_submittal_items').delete().eq('packet_id', targetPacket.id), 'Existing submittal removal failed');
      await removeItemFiles(targetItems);
      throwResult(await supabase.from('project_submittal_packets').update({
        packet_title: sourcePacket.packet_title,
        prepared_for: req.submittalJob.customer_name || null,
        revision: sourcePacket.revision,
        cover_notes: sourcePacket.cover_notes,
        issue_date: today(),
        updated_by_user_id: req.session.userId || null,
      }).eq('id', targetPacket.id), 'Imported packet details update failed');
    }

    let order = await nextSortOrder(targetPacket.id);
    for (const sourceItem of sourceItems) {
      const copiedItem = throwResult(await supabase.from('project_submittal_items').insert({
        packet_id: targetPacket.id,
        section_number: sourceItem.section_number,
        title: sourceItem.title,
        manufacturer: sourceItem.manufacturer,
        product_name: sourceItem.product_name,
        model_number: sourceItem.model_number,
        notes: sourceItem.notes,
        sort_order: order,
        created_by_user_id: req.session.userId || null,
      }).select().single(), 'Imported submittal create failed');
      order += 10;
      for (const sourceFile of sourceItem.files) {
        const fileBuffer = await storage.downloadBuffer(sourceFile.storage_bucket || BUCKET, sourceFile.storage_key);
        const fileName = safeFilename(sourceFile.file_name);
        const targetKey = `project-submittals/${req.params.id}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
        await storage.uploadBuffer(BUCKET, targetKey, fileBuffer, 'application/pdf');
        throwResult(await supabase.from('project_submittal_files').insert({
          item_id: copiedItem.id,
          file_name: fileName,
          storage_bucket: BUCKET,
          storage_key: targetKey,
          mime_type: 'application/pdf',
          size_bytes: fileBuffer.length,
          page_count: sourceFile.page_count || await pageCount(fileBuffer),
          created_by_user_id: req.session.userId || null,
        }), 'Imported submittal file create failed');
      }
    }
    setFlash(req, 'success', `${sourceItems.length} submittal${sourceItems.length === 1 ? '' : 's'} imported from ${sourceJob.title}.`);
    res.redirect(`/projects/${req.params.id}/submittals`);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/submittals/packet.pdf', requireSubmittalAccess, async (req, res, next) => {
  try {
    const packet = await ensurePacket(req.submittalJob, req.session.userId, res.locals.currentUser?.name);
    const items = await loadItems(packet.id);
    if (!items.length) {
      setFlash(req, 'error', 'Add at least one submittal before building the packet.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    const totalBytes = items.flatMap(item => item.files).reduce((sum, file) => sum + Number(file.size_bytes || 0), 0);
    if (totalBytes > MAX_PACKET_SIZE) {
      setFlash(req, 'error', 'This packet is over 100 MB. Split it into smaller product-spec PDFs before building.');
      return res.redirect(`/projects/${req.params.id}/submittals`);
    }
    for (const item of items) {
      item.files = await Promise.all(item.files.map(async file => ({
        ...file,
        buffer: await storage.downloadBuffer(file.storage_bucket || BUCKET, file.storage_key),
      })));
    }
    const company = throwResult(await supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(), 'Company settings load failed') || {};
    const pdf = await buildSubmittalPacket({ packet, job: req.submittalJob, company, items });
    const filename = `${slug(req.submittalJob.title)}-submittal-package.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
