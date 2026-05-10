/**
 * timeline.js — Build a unified day timeline from WO schedule + audit + notes + photos.
 *
 * buildDayTimeline({ date, userId, workerOnly }) → array of WO objects with events[].
 */
const db = require('../db/db');

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Build the timeline for a single day.
 * @param {string} date  — 'YYYY-MM-DD'
 * @param {number|null} userId — session user ID (for worker filtering)
 * @param {boolean} workerOnly — if true, only return WOs assigned to this user
 * @returns {Array} [{ wo_id, display_number, scheduled_time, status, customer_name, job_title, address, assignee_name, events: [...] }]
 */
function buildDayTimeline({ date, userId = null, workerOnly = false }) {
  // ── Step 1: Get WOs scheduled for this day ──
  const woConds = ['w.scheduled_date = ?'];
  const woParams = [date];

  if (workerOnly && userId) {
    woConds.push('(w.assigned_to_user_id = ? OR w.assigned_to LIKE ?)');
    const userName = (() => {
      try { const u = db.get('SELECT name FROM users WHERE id = ?', [userId]); return u ? u.name : ''; } catch(e) { return ''; }
    })();
    woParams.push(userId, `%${userName}%`);
  }

  const wos = db.all(`
    SELECT w.id, w.display_number, w.scheduled_time, w.status,
           w.assigned_to_user_id, w.assigned_to,
           j.id AS job_id, j.title AS job_title,
           j.address AS job_address, j.city AS job_city,
           c.id AS customer_id, c.name AS customer_name,
           u.name AS assigned_user_name
    FROM work_orders w
    JOIN jobs j ON j.id = w.job_id
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN users u ON u.id = w.assigned_to_user_id
    WHERE ${woConds.join(' AND ')}
      AND w.status IN ('scheduled','in_progress','complete')
    ORDER BY COALESCE(w.scheduled_time, '99:99'), w.display_number
  `, woParams);

  if (wos.length === 0) return [];

  // ── Step 2: Gather events for each WO ──
  const woIds = wos.map(w => w.id);

  // 2a. wo_notes today
  const notes = db.all(`
    SELECT wn.work_order_id, wn.body, wn.created_at, u.name AS actor_name
    FROM wo_notes wn
    LEFT JOIN users u ON u.id = wn.user_id
    WHERE wn.work_order_id IN (${woIds.map(() => '?').join(',')})
      AND date(wn.created_at) = date(?)
    ORDER BY wn.created_at ASC
  `, [...woIds, date]);

  // 2b. Audit logs for work order status changes today
  const auditEvents = db.all(`
    SELECT al.entity_id, al.action, al.after_json, al.created_at, u.name AS actor_name
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE al.entity_type = 'work_order'
      AND al.entity_id IN (${woIds.map(() => '?').join(',')})
      AND date(al.created_at) = date(?)
      AND al.action IN ('started','completed','cancelled','status_transition')
    ORDER BY al.created_at ASC
  `, [...woIds, date]);

  // 2b2. Item-completion audit events (work_order_line_item)
  const itemEvents = db.all(`
    SELECT al.entity_id, al.action, al.after_json, al.created_at, u.name AS actor_name
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE al.entity_type = 'work_order_line_item'
      AND date(al.created_at) = date(?)
      AND al.action = 'item_completed'
    ORDER BY al.created_at ASC
  `, [date]);

  // 2c. Audit logs for linked estimates/invoices today
  const woToEstInv = db.all(`
    SELECT e.id AS est_id, e.work_order_id,
           i.id AS inv_id
    FROM estimates e
    LEFT JOIN invoices i ON i.estimate_id = e.id
    WHERE e.work_order_id IN (${woIds.map(() => '?').join(',')})
  `, woIds);

  const estIds = woToEstInv.map(r => r.est_id).filter(Boolean);
  const invIds = woToEstInv.map(r => r.inv_id).filter(Boolean);

  let estAuditEvents = [];
  let invAuditEvents = [];
  if (estIds.length > 0) {
    estAuditEvents = db.all(`
      SELECT al.entity_id, al.action, al.after_json, al.created_at
      FROM audit_logs al
      WHERE al.entity_type = 'estimate'
        AND al.entity_id IN (${estIds.map(() => '?').join(',')})
        AND date(al.created_at) = date(?)
        AND al.action IN ('sent','accepted','rejected')
      ORDER BY al.created_at ASC
    `, [...estIds, date]);
  }
  if (invIds.length > 0) {
    invAuditEvents = db.all(`
      SELECT al.entity_id, al.action, al.after_json, al.created_at
      FROM audit_logs al
      WHERE al.entity_type = 'invoice'
        AND al.entity_id IN (${invIds.map(() => '?').join(',')})
        AND date(al.created_at) = date(?)
        AND al.action IN ('sent','paid','payment_received')
      ORDER BY al.created_at ASC
    `, [...invIds, date]);
  }

  // 2d. wo_photos (placeholder)
  // Not implemented yet — photos table exists but no photo upload UI.
  // When implemented, query by work_order_id + date(created_at), group 5-min buckets.

  // ── Step 3: Build per-WO event lists ──
  const eventsByWO = {};

  wos.forEach(wo => { eventsByWO[wo.id] = []; });

  // Group consecutive item completions on the same WO within 5 minutes
  const groupedItems = {};
  itemEvents.forEach(ie => {
    const ts = String(ie.created_at || '').slice(0, 16); // YYYY-MM-DD HH:MM (minute precision)
    const bucket = `${ie.entity_id}_${ts}`;
    if (!groupedItems[bucket]) groupedItems[bucket] = [];
    groupedItems[bucket].push(ie);
  });

  // Merge adjacent buckets within 5 minutes on same WO
  const mergedGroups = [];
  const sortedItems = [...itemEvents].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  let currentGroup = null;
  sortedItems.forEach(ie => {
    try {
      const after = JSON.parse(ie.after_json || '{}');
      const woId = after.wo_id;
      if (!currentGroup || currentGroup.wo_id !== woId) {
        if (currentGroup) mergedGroups.push(currentGroup);
        currentGroup = { wo_id: woId, events: [ie], startTime: ie.created_at };
      } else {
        const minsAgo = (new Date(ie.created_at) - new Date(currentGroup.startTime)) / 60000;
        if (minsAgo <= 5 && currentGroup.wo_id === woId) {
          currentGroup.events.push(ie);
        } else {
          mergedGroups.push(currentGroup);
          currentGroup = { wo_id: woId, events: [ie], startTime: ie.created_at };
        }
      }
    } catch(e) { /* skip unparseable */ }
  });
  if (currentGroup) mergedGroups.push(currentGroup);

  // Convert groups to timeline events
  mergedGroups.forEach(group => {
    if (!eventsByWO[group.wo_id]) return;
    const count = group.events.length;
    const firstEvent = group.events[0];
    const ts = String(firstEvent.created_at || '').slice(11, 16);
    const actor = firstEvent.actor_name || '';
    let label = '';
    if (count === 1) {
      try {
        const after = JSON.parse(firstEvent.after_json || '{}');
        label = `Marked done: ${after.description || 'item'}`;
      } catch(e) { label = 'Marked 1 item done'; }
    } else {
      label = `Marked ${count} items done`;
    }
    eventsByWO[group.wo_id].push({ type: 'item_completed', ts, label, actor });
  });

  // Add audit events for WO status changes
  auditEvents.forEach(ae => {
    const ts = String(ae.created_at || '').slice(11, 16);
    const actor = ae.actor_name || 'System';
    let label = '';
    if (ae.action === 'started') label = `${actor} started work`;
    else if (ae.action === 'completed') label = `${actor} marked WO complete`;
    else if (ae.action === 'cancelled') label = `${actor} cancelled WO`;
    else if (ae.action === 'photo_uploaded') {
      let cnt = '';
      try { const a = JSON.parse(ae.after_json || '{}'); cnt = a.count ? ` ${a.count}` : ''; } catch(e) {}
      label = `${actor} uploaded${cnt} photo${cnt === ' 1' ? '' : 's'}`;
    } else if (ae.action === 'status_transition') {
      try {
        const after = typeof ae.after_json === 'string' ? JSON.parse(ae.after_json) : (ae.after_json || {});
        label = `Status: ${(after.status || '').replace('_',' ')}`;
      } catch(e) { label = `Status changed by ${actor}`; }
    } else { label = `${actor} — ${ae.action}`; }
    if (eventsByWO[ae.entity_id]) {
      eventsByWO[ae.entity_id].push({ type: ae.action, ts, label, actor });
    }
  });

  // Add notes
  notes.forEach(n => {
    const ts = String(n.created_at || '').slice(11, 16);
    const body = (n.body || '').length > 80 ? (n.body || '').slice(0, 80) + '...' : (n.body || '');
    const actor = n.actor_name || '';
    eventsByWO[n.work_order_id].push({ type: 'note', ts, label: body, actor });
  });

  // Add estimate events
  estAuditEvents.forEach(ae => {
    const ts = String(ae.created_at || '').slice(11, 16);
    const wo = woToEstInv.find(r => r.est_id === ae.entity_id);
    if (wo && eventsByWO[wo.work_order_id]) {
      let label = '';
      if (ae.action === 'sent') label = 'Estimate sent';
      else if (ae.action === 'accepted') label = 'Estimate accepted';
      else if (ae.action === 'rejected') label = 'Estimate rejected';
      eventsByWO[wo.work_order_id].push({ type: `estimate_${ae.action}`, ts, label, actor: 'System' });
    }
  });

  // Add invoice events
  invAuditEvents.forEach(ae => {
    const ts = String(ae.created_at || '').slice(11, 16);
    const wo = woToEstInv.find(r => r.inv_id === ae.entity_id);
    if (wo && eventsByWO[wo.work_order_id]) {
      let label = '';
      if (ae.action === 'sent') label = 'Invoice sent';
      else if (ae.action === 'paid') label = 'Invoice paid';
      else if (ae.action === 'payment_received') {
        let amt = '';
        try { const after = typeof ae.after_json === 'string' ? JSON.parse(ae.after_json) : (ae.after_json || {}); amt = after.amount ? ` $${Number(after.amount).toFixed(2)}` : ''; } catch(e) {}
        label = `Payment received${amt}`;
      }
      eventsByWO[wo.work_order_id].push({ type: `invoice_${ae.action}`, ts, label, actor: 'System' });
    }
  });

  // Sort events per WO by timestamp
  Object.values(eventsByWO).forEach(evts => {
    evts.sort((a, b) => (a.ts || '99:99').localeCompare(b.ts || '99:99'));
  });

  // ── Step 4: Build final output ──
  const result = wos.map(wo => ({
    wo_id: wo.id,
    display_number: wo.display_number,
    scheduled_time: wo.scheduled_time,
    status: wo.status,
    customer_id: wo.customer_id,
    customer_name: wo.customer_name,
    job_id: wo.job_id,
    job_title: wo.job_title,
    address: [wo.job_address, wo.job_city].filter(Boolean).join(', '),
    assignee_name: wo.assigned_user_name || wo.assigned_to || 'Unassigned',
    events: eventsByWO[wo.id] || [],
  }));

  // Sort WOs by earliest event time (scheduled_time for WOs with no events,
  // or the first event ts for those with events)
  result.sort((a, b) => {
    const aTime = a.events.length > 0 ? a.events[0].ts : (a.scheduled_time || '99:99');
    const bTime = b.events.length > 0 ? b.events[0].ts : (b.scheduled_time || '99:99');
    return aTime.localeCompare(bTime);
  });

  return result;
}

module.exports = { buildDayTimeline };
