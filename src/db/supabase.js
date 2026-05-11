/**
 * Supabase JS SDK client (REST API over HTTPS).
 *
 * Replaces direct pg connections for database operations.
 * Falls back to sql.js mode if SUPABASE_URL/SUPABASE_SERVICE_KEY are missing.
 */
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY missing — db calls will fail');
}

const supabase = createClient(url || '', key || '', {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});

module.exports = supabase;
