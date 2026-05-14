/**
 * announcements.js — D-090: dynamic banner changelog announcements
 *
 * Provides functions to fetch active announcements from the app_announcements
 * table, and CRUD for admin management.
 */

const supabase = require('../db/supabase');

const ANNOUNCEMENT_CACHE_TTL = 60 * 1000; // 1 minute
let _cache = { data: null, ts: 0 };

/**
 * Fetch the single active announcement (if any) for the banner.
 * Ordered by created_at DESC, limited to 1 where active=true.
 * Cached for 1 minute to avoid DB call on every page render.
 */
async function getActiveAnnouncement() {
  const now = Date.now();
  if (_cache.data !== null && (now - _cache.ts) < ANNOUNCEMENT_CACHE_TTL) {
    return _cache.data;
  }

  try {
    const { data, error } = await supabase
      .from('app_announcements')
      .select('id, message, created_at, created_by_name')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('[announcements] getActiveAnnouncement error:', error.message);
      _cache = { data: null, ts: Date.now() };
      return null;
    }

    _cache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.warn('[announcements] getActiveAnnouncement exception:', e.message);
    _cache = { data: null, ts: Date.now() };
    return null;
  }
}

/**
 * Invalidate the cache so the next call fetches fresh data.
 * Called after create / deactivate.
 */
function invalidateCache() {
  _cache = { data: null, ts: 0 };
}

/**
 * List all announcements (for admin page), newest first.
 */
async function listAll(limit = 50, offset = 0) {
  const { data, count, error } = await supabase
    .from('app_announcements')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { data: data || [], count };
}

/**
 * Create a new announcement and deactivate any previously active one.
 */
async function createAnnouncement({ message, createdById, createdByName }) {
  // Deactivate any existing active announcements
  const { error: deactivateError } = await supabase
    .from('app_announcements')
    .update({ active: false })
    .eq('active', true);

  if (deactivateError) throw deactivateError;

  // Insert the new announcement
  const { data, error } = await supabase
    .from('app_announcements')
    .insert({
      message,
      active: true,
      created_by_id: createdById,
      created_by_name: createdByName,
    })
    .select()
    .single();

  if (error) throw error;

  invalidateCache();
  return data;
}

/**
 * Deactivate an announcement by ID (soft-delete via active=false).
 */
async function deactivate(id) {
  const { error } = await supabase
    .from('app_announcements')
    .update({ active: false })
    .eq('id', id);

  if (error) throw error;
  invalidateCache();
}

module.exports = {
  getActiveAnnouncement,
  listAll,
  createAnnouncement,
  deactivate,
  invalidateCache,
};
