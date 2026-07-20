const crypto = require('crypto');
const path = require('path');
const supabase = require('../db/supabase');
const storage = require('./storage');
const files = require('./files');

const BUCKET = 'entity-files';
const MAX_BILL_PDF_SIZE = 25 * 1024 * 1024;

function safeFilename(filename) {
  return path.basename(String(filename || 'invoice.pdf'))
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 180) || 'invoice.pdf';
}

function parsePendingBillPdf(body, userId) {
  const storageKey = String(body?.invoice_pdf_storage_key || '').trim();
  const rawOriginalFilename = String(body?.invoice_pdf_original_filename || '').trim();
  const originalFilename = safeFilename(rawOriginalFilename);
  const mimeType = String(body?.invoice_pdf_mime_type || '').trim().toLowerCase();
  const sizeBytes = Number(body?.invoice_pdf_size_bytes || 0);
  const supplied = storageKey || body?.invoice_pdf_original_filename || body?.invoice_pdf_size_bytes;
  if (!supplied) return null;

  const expectedPrefix = `bill-invoices/${Number(userId)}/`;
  if (!storageKey.startsWith(expectedPrefix) || storageKey.includes('..')) {
    throw new Error('Invalid invoice PDF upload key.');
  }
  if (!rawOriginalFilename) throw new Error('The invoice PDF filename is missing.');
  if (path.extname(originalFilename).toLowerCase() !== '.pdf') {
    throw new Error('The vendor invoice must be a PDF.');
  }
  if (mimeType && !['application/pdf', 'application/octet-stream'].includes(mimeType)) {
    throw new Error('The vendor invoice must be a PDF.');
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_BILL_PDF_SIZE) {
    throw new Error('The invoice PDF must be 25 MB or smaller.');
  }

  return {
    storageKey,
    originalFilename,
    mimeType: 'application/pdf',
    sizeBytes: Math.round(sizeBytes),
  };
}

async function prepareBillPdfUpload({ filename, size, contentType, userId }) {
  const originalFilename = safeFilename(filename);
  const sizeBytes = Number(size || 0);
  const normalizedType = String(contentType || '').trim().toLowerCase();
  if (path.extname(originalFilename).toLowerCase() !== '.pdf') {
    throw new Error('Choose a PDF invoice.');
  }
  if (normalizedType && !['application/pdf', 'application/octet-stream'].includes(normalizedType)) {
    throw new Error('Choose a PDF invoice.');
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error('The PDF is empty.');
  if (sizeBytes > MAX_BILL_PDF_SIZE) throw new Error('The invoice PDF must be 25 MB or smaller.');

  const key = `bill-invoices/${Number(userId)}/${crypto.randomUUID()}.pdf`;
  return storage.getUploadUrl(BUCKET, key);
}

async function resolveTargetRoot(bill, userId) {
  let entityType = 'vendor';
  let entityId = bill.vendor_id;
  if (bill.job_id) {
    // Project files use the established work_order-backed root in Forge.
    entityType = 'work_order';
    entityId = bill.job_id;
  } else if (bill.work_order_id) {
    entityType = 'work_order';
    entityId = bill.work_order_id;
  }

  const rootId = await files.ensureRootFolder(entityType, entityId, userId);
  const root = await files.getRootFolder(entityType, entityId);
  if (!root || Number(root.id) !== Number(rootId)) throw new Error('Could not prepare the invoice file folder.');
  return root;
}

async function registerBillPdf({ billId, bill, vendorName, upload, userId }) {
  if (!upload) return null;
  let fileRow = null;
  try {
    const root = await resolveTargetRoot(bill, userId);
    const vendorFolderName = vendorName || `Vendor ${bill.vendor_id}`;
    const targetFolder = await files.ensureFolderPath(root, ['Invoices', vendorFolderName], userId);
    const { data, error } = await supabase
      .from('files')
      .insert({
        folder_id: targetFolder.id,
        name: upload.originalFilename,
        original_filename: upload.originalFilename,
        storage_path: upload.storageKey,
        mime_type: upload.mimeType,
        size_bytes: upload.sizeBytes,
        uploaded_by_user_id: userId || null,
      })
      .select('id, folder_id, name, original_filename, storage_path, mime_type, size_bytes')
      .single();
    if (error) throw error;
    fileRow = data;

    const { error: billError } = await supabase
      .from('bills')
      .update({ attachment_file_id: fileRow.id })
      .eq('id', billId);
    if (billError) throw billError;
    return fileRow;
  } catch (error) {
    if (fileRow?.id) {
      try {
        await supabase.from('files').delete().eq('id', fileRow.id);
      } catch (_) { /* best-effort cleanup */ }
    }
    await storage.remove(BUCKET, upload.storageKey).catch(() => {});
    throw error;
  }
}

module.exports = {
  MAX_BILL_PDF_SIZE,
  parsePendingBillPdf,
  prepareBillPdfUpload,
  registerBillPdf,
};
