/**
 * Audit log helper — converted to Supabase SDK.
 *
 * Every financial mutation should call writeAudit() with:
 *   - entityType: 'invoice', 'bill', 'payment', 'journal_entry', 'estimate', 'work_order', etc.
 *   - entityId:   primary key of the row
 *   - action:     'create'|'update'|'delete'|'status_change'|'post_je'|'send'|'pay'|'void'|...
 *   - before:     object snapshot before the change (or null for create)
 *   - after:      object snapshot after the change (or null for delete)
 *   - source:     'user'|'ai'|'stripe'|'plaid'|'system' (default 'user')
 *   - userId:     session user id (or null for system events)
 *   - reason:     optional text
 *
 * before/after are JSON-serialized. Pass plain objects.
 */
const supabase = require('../db/supabase');

async function writeAudit({ entityType, entityId, action, before, after, source, userId, reason }) {
  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert({
        entity_type: entityType,
        entity_id: entityId,
        action,
        before_json: before == null ? null : JSON.stringify(before),
        after_json: after == null ? null : JSON.stringify(after),
        source: source || 'user',
        user_id: userId || null,
        reason: reason || null,
      });
    if (error) throw error;
  } catch (e) {
    // Audit failures must never break the operation that triggered them.
    // The audit_logs table may not exist yet if init-accounting hasn't run.
    console.error('audit log write failed (continuing):', e.message);
  }
}

/** Convenience: pull recent audit rows for an entity. */
async function listAudit(entityType, entityId, limit = 50) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*, users(name)')
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(r => ({
    ...r,
    user_name: r.users?.name || null,
    users: undefined,
  }));
}

module.exports = { writeAudit, listAudit };
