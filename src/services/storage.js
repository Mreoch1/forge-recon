/**
 * Supabase Storage wrapper.
 *
 * Uploads files to Supabase Storage buckets, returns signed URLs.
 *
 * Buckets:
 *   wo-photos    — private, signed URLs (WO photos & files gallery)
 *   entity-files — private, signed URLs (/files/:id/view)
 *   bills        — private, signed URLs (bill attachments)
 */
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY, { realtime: { transport: WebSocket } }) : null;

async function uploadBuffer(bucket, key, buffer, contentType) {
  if (!supa) throw new Error('Supabase Storage not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required)');
  const { error } = await supa.storage.from(bucket).upload(key, buffer, { contentType, upsert: false });
  if (error) throw error;
  return { bucket, key };
}

async function getPublicUrl(bucket, key) {
  if (!supa) throw new Error('Supabase not configured');
  return supa.storage.from(bucket).getPublicUrl(key).data.publicUrl;
}

async function getSignedUrl(bucket, key, ttlSeconds = 3600) {
  if (!supa) throw new Error('Supabase not configured');
  const { data, error } = await supa.storage.from(bucket).createSignedUrl(key, ttlSeconds);
  if (error) throw error;
  return data.signedUrl;
}

async function downloadBuffer(bucket, key) {
  if (!supa) throw new Error('Supabase not configured');
  const { data, error } = await supa.storage.from(bucket).download(key);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function remove(bucket, key) {
  if (!supa) throw new Error('Supabase not configured');
  const { error } = await supa.storage.from(bucket).remove([key]);
  if (error) throw error;
}

/**
 * Generate a presigned upload URL so the client can upload large files
 * directly to Supabase Storage without going through the serverless function.
 * Uses the service role key to generate a publicly-uploadable URL.
 * @param {string} bucket - Storage bucket name
 * @param {string} key - Storage key/path
 * @returns {Promise<{storageKey: string, uploadUrl: string, uploadToken: string, bucket: string}>}
 */
async function getUploadUrl(bucket, key) {
  if (!supa) throw new Error('Supabase Storage not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required)');

  const { data, error } = await supa.storage.from(bucket).createSignedUploadUrl(key, { upsert: true });
  if (error) throw error;

  const signedPath = data?.signedUrl || data?.url;
  if (!signedPath) throw new Error('No upload URL in response');
  const uploadToken = data?.token || null;
  if (!uploadToken) throw new Error('No signed upload token in response');

  const basePath = signedPath.startsWith('/storage/') ? '' : '/storage/v1';
  const uploadUrl = signedPath.startsWith('http') ? signedPath : `${SUPA_URL}${basePath}${signedPath}`;
  return { storageKey: key, uploadUrl, uploadToken, bucket };
}

module.exports = { uploadBuffer, getPublicUrl, getSignedUrl, downloadBuffer, remove, getUploadUrl };
