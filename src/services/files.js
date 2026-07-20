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

async function findRootFolder(entityType, entityId, selectColumns = '*', label = 'file root folder read failed') {
  if (!entityType || !entityId) return null;
  const { data } = await checkedFileRead(supabase
    .from('folders')
    .select(selectColumns)
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .eq('is_root', 1)
    .order('id', { ascending: true })
    .limit(1), label);
  return (data && data[0]) || null;
}

async function ensureRootFolder(entityType, entityId, createdByUserId) {
  if (!entityType || !entityId) return null;
  const existing = await findRootFolder(entityType, entityId, 'id', 'file root folder lookup failed');
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
  return findRootFolder(entityType, entityId);
}

function cleanFolderName(name) {
  return String(name || '')
    .replace(/[\\/<>:"|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

async function ensureSubfolder(parentFolder, name, createdByUserId) {
  if (!parentFolder?.id) throw new Error('Parent folder is required.');
  const safeName = cleanFolderName(name);
  if (!safeName) throw new Error('Folder name is required.');

  const findExisting = async () => {
    const { data } = await checkedFileRead(supabase
      .from('folders')
      .select('*')
      .eq('parent_folder_id', parentFolder.id)
      .eq('name', safeName)
      .order('id', { ascending: true })
      .limit(1), 'file subfolder lookup failed');
    return (data && data[0]) || null;
  };

  const existing = await findExisting();
  if (existing) return existing;

  const { data: inserted, error } = await supabase
    .from('folders')
    .insert({
      parent_folder_id: parentFolder.id,
      name: safeName,
      entity_type: parentFolder.entity_type,
      entity_id: String(parentFolder.entity_id),
      is_root: 0,
      created_by_user_id: createdByUserId || null,
    })
    .select('*')
    .single();
  if (!error) return inserted;

  // Another request may have created the same folder while this one was saving.
  const racedFolder = await findExisting();
  if (racedFolder) return racedFolder;
  throw error;
}

async function ensureFolderPath(rootFolder, names, createdByUserId) {
  let current = rootFolder;
  for (const name of names || []) {
    current = await ensureSubfolder(current, name, createdByUserId);
  }
  return current;
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

module.exports = {
  ensureRootFolder,
  ensureSubfolder,
  ensureFolderPath,
  getRootFolder,
  getFolderContents,
  getEntityList,
};
