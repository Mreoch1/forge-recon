/**
 * Supabase Storage wrapper.
 *
 * Uploads files to Supabase Storage buckets, returns public or signed URLs.
 *
 * Buckets:
 *   wo-photos    — public read (WO show page gallery)
 *   entity-files — private, signed URLs (/files/:id/view)
 *   bills        — private, signed URLs (bill attachments)
 */
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY, { realtime: { transport: WebSocket } }) : null;

async function uploadBuffer(bucket, key, buffer, contentType) {
  if (!supa) throw new Error('Supabase not configured (SUPABASE_URL + key required)');
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
 * Generate parameters for direct browser-to-Supabase upload.
 * Returns the storage key and the Supabase upload URL + public anon key
 * so the client can upload large files directly without going through Vercel.
 * @param {string} bucket - Storage bucket name
 * @param {string} key - Storage key/path
 * @returns {Promise<{storageKey: string, uploadUrl: string, anonKey: string}>}
 */
async function getUploadUrl(bucket, key) {
  if (!SUPA_URL) throw new Error('SUPABASE_URL not configured');
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY required for direct uploads');
  // Direct upload URL to Supabase Storage REST API
  const uploadUrl = `${SUPA_URL}/storage/v1/object/${bucket}/${key}`;
  return { storageKey: key, uploadUrl, anonKey };
}

module.exports = { uploadBuffer, getPublicUrl, getSignedUrl, downloadBuffer, remove, getUploadUrl };
