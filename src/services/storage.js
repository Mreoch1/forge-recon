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
 * Generate a presigned upload URL so the client can upload large files
 * directly to Supabase Storage without going through the serverless function.
 * Uses the service role key to generate a publicly-uploadable URL.
 * @param {string} bucket - Storage bucket name
 * @param {string} key - Storage key/path
 * @returns {Promise<{storageKey: string, uploadUrl: string}>}
 */
async function getUploadUrl(bucket, key) {
  if (!SUPA_URL) throw new Error('SUPABASE_URL not configured');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY required for presigned upload URLs');

  // Use Supabase Storage REST API with service role key to sign an upload URL
  const signUrl = `${SUPA_URL}/storage/v1/object/upload/sign/${bucket}/${key}`;
  const res = await fetch(signUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsert: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    throw new Error(`Presigned URL failed: ${res.status} ${text}`);
  }
  const result = await res.json();
  return { storageKey: key, uploadUrl: result.url || result.signedUrl || result.data?.url };
}

module.exports = { uploadBuffer, getPublicUrl, getSignedUrl, downloadBuffer, remove, getUploadUrl };
