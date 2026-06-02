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

const SUPA_URL = process.env.SUPABASE_URL;
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
 * Generate a presigned upload URL so the client can upload large files
 * directly to Supabase Storage without going through the serverless function.
 * @param {string} bucket - Storage bucket name
 * @param {string} key - Storage key/path
 * @param {number} [ttlSeconds=3600] - URL validity in seconds
 * @returns {Promise<string>} Presigned upload URL
 */
async function getUploadUrl(bucket, key, ttlSeconds = 3600) {
  if (!supa) throw new Error('Supabase not configured');
  const { data, error } = await supa.storage.from(bucket).createSignedUploadUrl(key, { upsert: true });
  if (error) throw error;
  return data.url;
}

module.exports = { uploadBuffer, getPublicUrl, getSignedUrl, downloadBuffer, remove, getUploadUrl };
