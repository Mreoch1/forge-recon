/**
 * timeline.js - Build a unified day timeline from WO schedule + audit + notes + photos.
 *
 * buildDayTimeline({ date, userId, workerOnly }) -> array of WO objects with events[].
 */
const supabase = require('../db/supabase');

function pad2(n) { return String(n).padStart(2, '0'); }

function dateOnly(ts) {
  // Return YYYY-MM-DD portion of an ISO/SQL timestamp string.
  return String(ts || '').slice(0, 10);
}

/**
 * Build the timeline for a single day.
 * @param {string} date  - 'YYYY-MM-DD'
 * @param {number|null} userId - session user ID (for worker filtering)
 * @param {boolean} workerOnly - if true, only return WOs assigned to this user
 * @returns {Array} [{ wo_id, display_number, scheduled_time, status, customer_name, job_title, address, assignee_name, events: [...] }]
 */
async function buildDayTimeline({ date, userId = null, workerOnly = false }) {
  // Step 1: Get WOs scheduled for this day
  let woQuery = supabase
    .from('work_orders')
    .select(`
      id, display_number, scheduled_time, status,
      assigned_to_user_id, assigned_to,
      customer_id, customers!left ( id, name ),
      jobs!left ( id, title, address, city, customers!left ( id, name ) ),
      users:assigned_to_user_id ( name )
    `)
    .eq('scheduled_date', date)
    .in('status', ['scheduled', 'in_progress', 'complete']);

  if (workerOnly && userId) {
    let userName = '';
    try {
      const { data: u } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
      userName = u ? (u.name || '') : '';
    } catch (e) { /* best effort */ }
    if (userName) {
      woQuery = woQuery.or(`assigned_to_user_id.eq.${userId},assigned_to.ilike.%${userName}%`);
    } else {
      woQuery = woQuery.eq('assigned_to_user_id', userId);
    }
  }

  const { data: woRows, error: woErr } = await woQuery;
  if (woErr) throw woErr;

  // Flatten nested rows to legacy shape used by callers
  const wos = (woRows || []).map(r => ({
    id: r.id,
    display_number: r.display_number,
    scheduled_time: r.scheduled_time,
    status: r.status,
    assigned_to_user_id: r.assigned_to_user_id,
    assigned_to: r.assigned_to,
    job_id: r.jobs?.id,
    job_title: r.jobs?.title,
    job_address: r.jobs?.address,
    job_city: r.jobs?.city,
    // Customer-rooted (R34) or job-rooted (legacy) — COALESCE both paths
    customer_id: r.customer_id || r.customers?.id || r.jobs?.customers?.id,
    customer_name: r.customers?.name || r.jobs?.customers?.name,
    assigned_user_name: r.users?.name || null,
  }));

  wos.sort((a, b) => {
    const at = a.scheduled_time || '99:99';
    const bt = b.scheduled_time || '99:99';
    if (at !== bt) return at.localeCompare(bt);
    return String(a.display_number || '').localeCompare(String(b.display_number || ''));
  });

  if (wos.length === 0) return [];

  // Step 2: Gather events for each WO
  const woIds = wos.map(w => w.id);
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59.999`;

  // 2a. wo_notes today
  const { data: notesRaw, error: notesErr } = await supabase
    .from('wo_notes')
    .select('work_order_id, body, created_at, users:user_id ( name )')
    .in('work_order_id', woIds)
    .gte('created_at', dayStart)
    .lt('created_at', dayEnd)
    .order('created_at', { ascending: true });
  if (notesErr) throw notesErr;
  const notes = (notesRaw || []).map(n => ({
    work_order_id: n.work_order_id,
    body: n.body,
    created_at: n.created_at,
    actor_name: n.users?.name || null,
  }));

  // 2b. Audit logs for work order status changes today
  const { data: auditRaw, error: auditErr } = await supabase
    .from('audit_logs')
    .select('entity_id, action, after_json, created_at, users:user_id ( name )')
    .eq('entity_type', 'work_order')
    .in('entity_id', woIds.map(String))
    .gte('created_at', dayStart)
    .lt('created_at', dayEnd)
    .in('action', ['started', 'completed', 'cancelled', 'status_transition'])
    .order('created_at', { ascending: true });
  if (auditErr) throw auditErr;
  const auditEvents = (auditRaw || []).map(a => ({
    entity_id: typeof a.entity_id === 'string' ? parseInt(a.entity_id, 10) : a.entity_id,
    action: a.action,
    after_json: a.after_json,
    created_at: a.created_at,
    actor_name: a.users?.name || null,
  }));

  // 2b2. Item-completion audit events (work_order_line_item)
  const { data: itemRaw, error: itemErr } = await supabase
    .from('audit_logs')
    .select('entity_id, action, after_json, created_at, users:user_id ( name )')
    .eq('entity_type', 'work_order_line_item')
    .eq('action', 'item_completed')
    .gte('created_at', dayStart)
    .lt('created_at', dayEnd)
    .order('created_at', { ascending: true });
  if (itemErr) throw itemErr;
  const itemEvents = (itemRaw || []).map(a => ({
    entity_id: typeof a.entity_id === 'string' ? parseInt(a.entity_id, 10) : a.entity_id,
    action: a.action,
    after_json: a.after_json,
    created_at: a.created_at,
    actor_name: a.users?.name || null,
  }));

  // 2c. Audit logs for linked estimates/invoices today
  const { data: estLinks, error: estLinksErr } = await supabase
    .from('estimates')
    .select('id, work_order_id, invoices ( id )')
    .in('work_order_id', woIds);
  if (estLinksErr) throw estLinksErr;

  const woToEstInv = [];
  (estLinks || []).forEach(e => {
    const invs = Array.isArray(e.invoices) ? e.invoices : (e.invoices ? [e.invoices] : []);
    if (invs.length === 0) {
      woToEstInv.push({ est_id: e.id, work_order_id: e.work_order_id, inv_id: null });
    } else {
      invs.forEach(inv => {
        woToEstInv.push({ est_id: e.id, work_order_id: e.work_order_id, inv_id: inv?.id || null });
      });
    }
  });

  const estIds = woToEstInv.map(r => r.est_id).filter(Boolean);
  const invIds = woToEstInv.map(r => r.inv_id).filter(Boolean);

  let estAuditEvents = [];
  let invAuditEvents = [];
  if (estIds.length > 0) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('entity_id, action, after_json, created_at')
      .eq('entity_type', 'estimate')
      .in('entity_id', estIds.map(String))
      .gte('created_at', dayStart)
      .lt('created_at', dayEnd)
      .in('action', ['sent', 'accepted', 'rejected'])
      .order('created_at', { ascending: true });
    if (error) throw error;
    estAuditEvents = (data || []).map(a => ({
      entity_id: typeof a.entity_id === 'string' ? parseInt(a.entity_id, 10) : a.entity_id,
      action: a.action,
      after_json: a.after_json,
      created_at: a.created_at,
    }));
  }
  if (invIds.length > 0) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('entity_id, action, after_json, created_at')
      .eq('entity_type', 'invoice')
      .in('entity_id', invIds.map(String))
      .gte('created_at', dayStart)
      .lt('created_at', dayEnd)
      .in('action', ['sent', 'paid', 'payment_received'])
      .order('created_at', { ascending: true });
    if (error) throw error;
    invAuditEvents = (data || []).map(a => ({
      entity_id: typeof a.entity_id === 'string' ? parseInt(a.entity_id, 10) : a.entity_id,
      action: a.action,
      after_json: a.after_json,
      created_at: a.created_at,
    }));
  }

  // 2d. wo_photos (placeholder)
  // Not implemented yet - photos table exists but no photo upload UI.

  // Step 3: Build per-WO event lists
  const eventsByWO = {};
  wos.forEach(wo => { eventsByWO[wo.id] = []; });

  // Group consecutive item completions on the same WO within 5 minutes
  const sortedItems = [...itemEvents].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const mergedGroups = [];
  let currentGroup = null;
  sortedItems.forEach(ie => {
    try {
      const after = typeof ie.after_json === 'string' ? JSON.parse(ie.after_json || '{}') : (ie.after_json || {});
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
    } catch (e) { /* skip unparseable */ }
  });
  if (currentGroup) mergedGroups.push(currentGroup);

  mergedGroups.forEach(group => {
    if (!eventsByWO[group.wo_id]) return;
    const count = group.events.length;
    const firstEvent = group.events[0];
    const ts = String(firstEvent.created_at || '').slice(11, 16);
    const actor = firstEvent.actor_name || '';
    let label = '';
    if (count === 1) {
      try {
        const after = typeof firstEvent.after_json === 'string' ? JSON.parse(firstEvent.after_json || '{}') : (firstEvent.after_json || {});
        label = `Marked done: ${after.description || 'item'}`;
      } catch (e) { label = 'Marked 1 item done'; }
    } else {
      label = `Marked ${count} items done`;
    }
    eventsByWO[group.wo_id].push({ type: 'item_completed', ts, label, actor });
  });

  auditEvents.forEach(ae => {
    const ts = String(ae.created_at || '').slice(11, 16);
    const actor = ae.actor_name || 'System';
    let label = '';
    if (ae.action === 'started') label = `${actor} started work`;
    else if (ae.action === 'completed') label = `${actor} marked WO complete`;
    else if (ae.action === 'cancelled') label = `${actor} cancelled WO`;
    else if (ae.action === 'photo_uploaded') {
      let cnt = '';
      try {
        const a = typeof ae.after_json === 'string' ? JSON.parse(ae.after_json || '{}') : (ae.after_json || {});
        cnt = a.count ? ` ${a.count}` : '';
      } catch (e) { /* ignore */ }
      label = `${actor} uploaded${cnt} photo${cnt === ' 1' ? '' : 's'}`;
    } else if (ae.action === 'status_transition') {
      try {
        const after = typeof ae.after_json === 'string' ? JSON.parse(ae.after_json) : (ae.after_json || {});
        label = `Status: ${(after.status || '').replace('_', ' ')}`;
      } catch (e) { label = `Status changed by ${actor}`; }
    } else {
      label = `${actor} - ${ae.action}`;
    }
    if (eventsByWO[ae.entity_id]) {
      eventsByWO[ae.entity_id].push({ type: ae.action, ts, label, actor });
    }
  });

  notes.forEach(n => {
    const ts = String(n.created_at || '').slice(11, 16);
    const body = (n.body || '').length > 80 ? (n.body || '').slice(0, 80) + '...' : (n.body || '');
    const actor = n.actor_name || '';
    if (eventsByWO[n.work_order_id]) {
      eventsByWO[n.work_order_id].push({ type: 'note', ts, label: body, actor });
    }
  });

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

  invAuditEvents.forEach(ae => {
    const ts = String(ae.created_at || '').slice(11, 16);
    const wo = woToEstInv.find(r => r.inv_id === ae.entity_id);
    if (wo && eventsByWO[wo.work_order_id]) {
      let label = '';
      if (ae.action === 'sent') label = 'Invoice sent';
      else if (ae.action === 'paid') label = 'Invoice paid';
      else if (ae.action === 'payment_received') {
        let amt = '';
        try {
          const after = typeof ae.after_json === 'string' ? JSON.parse(ae.after_json) : (ae.after_json || {});
          amt = after.amount ? ` $${Number(after.amount).toFixed(2)}` : '';
        } catch (e) { /* ignore */ }
        label = `Payment received${amt}`;
      }
      eventsByWO[wo.work_order_id].push({ type: `invoice_${ae.action}`, ts, label, actor: 'System' });
    }
  });

  Object.values(eventsByWO).forEach(evts => {
    evts.sort((a, b) => (a.ts || '99:99').localeCompare(b.ts || '99:99'));
  });

  // Step 4: Build final output
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

  result.sort((a, b) => {
    const aTime = a.events.length > 0 ? a.events[0].ts : (a.scheduled_time || '99:99');
    const bTime = b.events.length > 0 ? b.events[0].ts : (b.scheduled_time || '99:99');
    return aTime.localeCompare(bTime);
  });

  return result;
}

module.exports = { buildDayTimeline };
