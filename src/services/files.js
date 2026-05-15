/**
 * files.js — File system service: root folder auto-creation.
 * Converted to Supabase SDK.
 */
const supabase = require('../db/supabase');

function assertFileRead(result, label) {
  if (result?.error) {
    const err = new Error(`${label}: ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }
  return result || {};
}

async function checkedFileRead(query, label) {
  return assertFileRead(await query, label);
}

async function ensureRootFolder(entityType, entityId, createdByUserId) {
  if (!entityType || !entityId) return null;
  const { data: existing } = await checkedFileRead(supabase
    .from('folders')
    .select('id')
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .eq('is_root', 1)
    .maybeSingle(), 'file root folder lookup failed');
  if (existing) return existing.id;
  const { data: inserted, error } = await supabase
    .from('folders')
    .insert({
      name: entityType + '_' + entityId,
      entity_type: entityType,
      entity_id: String(entityId),
      is_root: 1,
      created_by_user_id: createdByUserId || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return inserted.id;
}

async function getRootFolder(entityType, entityId) {
  const { data } = await checkedFileRead(supabase
    .from('folders')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .eq('is_root', 1)
    .maybeSingle(), 'file root folder read failed');
  return data || null;
}

async function getFolderContents(folderId) {
  const [subfoldersResult, filesResult] = await Promise.all([
    supabase.from('folders').select('*').eq('parent_folder_id', folderId).order('name', { ascending: true }),
    supabase.from('files').select('*').eq('folder_id', folderId).order('created_at', { ascending: false }),
  ]);
  const { data: subfolders } = assertFileRead(subfoldersResult, 'subfolder list read failed');
  const { data: files } = assertFileRead(filesResult, 'folder files read failed');
  return { subfolders: subfolders || [], files: files || [] };
}

async function getEntityList(entityType) {
  if (entityType === 'customer') {
    const { data } = await checkedFileRead(supabase.from('customers').select('id, name').order('name', { ascending: true }), 'file customer list read failed');
    return data || [];
  }
  if (entityType === 'vendor') {
    const { data } = await checkedFileRead(supabase.from('vendors').select('id, name').order('name', { ascending: true }), 'file vendor list read failed');
    return data || [];
  }
  if (entityType === 'contractor') {
    const { data } = await checkedFileRead(supabase.from('contractors').select('id, name').order('name', { ascending: true }), 'file contractor list read failed');
    return data || [];
  }
  if (entityType === 'user' || entityType === 'worker') {
    const { data } = await checkedFileRead(supabase.from('users').select('id, name, role').eq('active', true).order('name', { ascending: true }), 'file user list read failed');
    return data || [];
  }
  if (entityType === 'work_order' || entityType === 'project') {
    const { data } = await checkedFileRead(supabase.from('work_orders').select('id, display_number').order('id', { ascending: false }), 'file work order list read failed');
    return (data || []).map(r => ({ id: r.id, name: r.display_number }));
  }
  return [];
}

module.exports = { ensureRootFolder, getRootFolder, getFolderContents, getEntityList };
