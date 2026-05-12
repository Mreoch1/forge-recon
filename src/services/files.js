/**
 * files.js — File system service: root folder auto-creation.
 * Converted to Supabase SDK.
 */
const supabase = require('../db/supabase');

async function ensureRootFolder(entityType, entityId, createdByUserId) {
  if (!entityType || !entityId) return null;
  const { data: existing } = await supabase
    .from('folders')
    .select('id')
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .eq('is_root', 1)
    .maybeSingle();
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
  const { data } = await supabase
    .from('folders')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .eq('is_root', 1)
    .maybeSingle();
  return data || null;
}

async function getFolderContents(folderId) {
  const [{ data: subfolders }, { data: files }] = await Promise.all([
    supabase.from('folders').select('*').eq('parent_folder_id', folderId).order('name', { ascending: true }),
    supabase.from('files').select('*').eq('folder_id', folderId).order('created_at', { ascending: false }),
  ]);
  return { subfolders: subfolders || [], files: files || [] };
}

async function getEntityList(entityType) {
  if (entityType === 'customer') {
    const { data } = await supabase.from('customers').select('id, name').order('name', { ascending: true });
    return data || [];
  }
  if (entityType === 'vendor') {
    const { data } = await supabase.from('vendors').select('id, name').order('name', { ascending: true });
    return data || [];
  }
  if (entityType === 'user' || entityType === 'worker') {
    const { data } = await supabase.from('users').select('id, name, role').eq('active', true).order('name', { ascending: true });
    return data || [];
  }
  if (entityType === 'work_order' || entityType === 'project') {
    const { data } = await supabase.from('work_orders').select('id, display_number').order('id', { ascending: false });
    return (data || []).map(r => ({ id: r.id, name: r.display_number }));
  }
  return [];
}

module.exports = { ensureRootFolder, getRootFolder, getFolderContents, getEntityList };
