/**
 * Audit log helper.
 *
 * Every financial mutation should call writeAudit() with:
 *   - entity_type: 'invoice', 'bill', 'payment', 'journal_entry', 'estimate', 'work_order', etc.
 *   - entity_id:   primary key of the row
 *   - action:      'create'|'update'|'delete'|'status_change'|'post_je'|'send'|'pay'|'void'|...
 *   - before:      object snapshot before the change (or null for create)
 *   - after:       object snapshot after the change (or null for delete)
 *   - source:      'user'|'ai'|'stripe'|'plaid'|'system' (default 'user')
 *   - userId:      session user id (or null for system events)
 *   - reason:      optional text
 *
 * before/after are JSON-serialized. Pass plain objects.
 */

const db = require('../db/db');

async function writeAudit({ entityType, entityId, action, before, after, source, userId, reason }) {
  try {
    await db.run(
      `INSERT INTO audit_logs
       (entity_type, entity_id, action, before_json, after_json, source, user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entityType,
        entityId,
        action,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        source || 'user',
        userId || null,
        reason || null,
      ]
    );
  } catch (e) {
    // Audit failures must never break the operation that triggered them.
    // The audit_logs table may not exist yet if init-accounting hasn't run.
    console.error('audit log write failed (continuing):', e.message);
  }
}

/** Convenience: pull recent audit rows for an entity. */
async function listAudit(entityType, entityId, limit = 50) {
  return await db.all(
    `SELECT a.*, u.name AS user_name
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity_type = ? AND a.entity_id = ?
     ORDER BY a.created_at DESC
     LIMIT ?`,
    [entityType, entityId, limit]
  );
}

module.exports = { writeAudit, listAudit };
