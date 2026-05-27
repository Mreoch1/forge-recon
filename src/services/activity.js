function db() {
  return require('../db/supabase');
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_e) { return null; }
}

function humanizeAction(action) {
  return String(action || 'update')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function actorName(row) {
  return row.user_name || row.users?.name || (row.source === 'ai' ? 'FORGE AI' : row.source === 'system' ? 'System' : 'Office');
}

function summarizeAudit(row) {
  const after = parseJson(row.after_json) || {};
  const before = parseJson(row.before_json) || {};
  const action = String(row.action || '');

  if (row.reason) return row.reason;
  if (action.includes('note') && after.body) return after.body;
  if (after.note) return after.note;
  if (after.recipient) return `Sent to ${after.recipient}`;
  if (after.status && before.status && after.status !== before.status) return `${before.status} -> ${after.status}`;
  if (after.total != null) return `Total ${after.total}`;
  if (after.line_count != null) return `${after.line_count} line item${Number(after.line_count) === 1 ? '' : 's'}`;
  if (after.count != null) return `${after.count} item${Number(after.count) === 1 ? '' : 's'}`;
  return '';
}

function auditTitle(entityType, action) {
  const subject = {
    work_order: 'Work order',
    estimate: 'Estimate',
    invoice: 'Invoice',
    bill: 'Bill',
    payment: 'Payment',
    file: 'File',
  }[entityType] || humanizeAction(entityType);
  return `${subject} ${humanizeAction(action).toLowerCase()}`;
}

function fromAudit(row) {
  return {
    id: `audit-${row.id}`,
    kind: String(row.action || '').includes('note') ? 'note' : 'system',
    title: auditTitle(row.entity_type, row.action),
    body: summarizeAudit(row),
    actor: actorName(row),
    created_at: row.created_at,
  };
}

function fromNote(row) {
  return {
    id: `note-${row.id}`,
    kind: 'note',
    title: 'Note added',
    body: row.body || '',
    actor: row.user_name || row.users?.name || 'Office',
    created_at: row.created_at,
  };
}

async function listAuditFor(entityType, entityId, limit = 50) {
  if (!entityType || !entityId) return [];
  const { data, error } = await db()
    .from('audit_logs')
    .select('id, entity_type, entity_id, action, before_json, after_json, source, reason, user_id, created_at, users!audit_logs_user_id_fkey(name)')
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[activity] audit read failed:', error.message);
    return [];
  }
  return (data || []).map(fromAudit);
}

async function listWorkOrderNotes(workOrderId) {
  if (!workOrderId) return [];
  const { data, error } = await db()
    .from('wo_notes')
    .select('id, body, created_at, user_id, users!wo_notes_user_id_fkey(name)')
    .eq('work_order_id', workOrderId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    console.warn('[activity] notes read failed:', error.message);
    return [];
  }
  return (data || []).map(fromNote);
}

async function listEntityActivity({ entityType, entityId, workOrderId, estimateId, invoiceId }) {
  const groups = [];
  if (workOrderId) groups.push(listAuditFor('work_order', workOrderId), listWorkOrderNotes(workOrderId));
  if (estimateId) groups.push(listAuditFor('estimate', estimateId));
  if (invoiceId) groups.push(listAuditFor('invoice', invoiceId));
  if (entityType && entityId && !groups.length) groups.push(listAuditFor(entityType, entityId));

  const rows = (await Promise.all(groups)).flat();
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = `${row.title}|${row.body}|${row.actor}|${row.created_at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 80);
}

module.exports = {
  _internal: { humanizeAction, summarizeAudit, fromAudit, fromNote },
  listEntityActivity,
};
