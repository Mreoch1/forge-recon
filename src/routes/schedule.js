/**
 * schedule.js — Schedule views (week, 2-week, month).
 *
 * GET /schedule — renders grid of WOs by date/time.
 *   ?view=week|2week|month  (default week)
 *   ?date=YYYY-MM-DD
 *   ?assignee=<user_id>
 */

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const scheduling = require('../services/scheduling');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const PALETTE = ['#4A90D9','#8BC34A','#9C76D9','#26A69A','#EF7E6B','#A5D6A7','#78909C','#FFCC80'];
function colorForUser(userId) { return userId ? PALETTE[Number(userId) % PALETTE.length] : null; }

const STATUS_COLORS = {
  scheduled: '#3b82f6',
  in_progress: '#ea580c',
  complete: '#10b981',
  cancelled: '#9ca3af',
  urgent: '#c0202b',
};
const WORK_ORDER_CUSTOMER_SELECT = 'id, display_number, status, scheduled_date, scheduled_time, assigned_to_user_id, assigned_to, scheduled_end_time, customer_id, customers!left(name), jobs!left(title, customers!left(name)), users!left(name), work_order_assignees(users!work_order_assignees_user_id_fkey(id, name))';

function workOrderDisplayFields(row) {
  const customerName = row.customers?.name || row.jobs?.customers?.name || '';
  return {
    job_title: row.jobs?.title || (customerName ? `${customerName} work order` : 'Customer work order'),
    customer_name: customerName,
  };
}

function assigneeNames(row) {
  return (row.work_order_assignees || [])
    .map(a => a.users?.name)
    .filter(Boolean);
}

function mapScheduleWorkOrder(row) {
  const names = assigneeNames(row);
  const joinedNames = names.join(', ');
  return {
    id: row.id, display_number: row.display_number, status: row.status,
    scheduled_date: row.scheduled_date, scheduled_time: row.scheduled_time,
    assigned_to_user_id: row.assigned_to_user_id, assigned_to: row.assigned_to,
    scheduled_end_time: row.scheduled_end_time,
    work_order_assignees: row.work_order_assignees || [],
    ...workOrderDisplayFields(row),
    assignee_user_name: row.users?.name || joinedNames,
    assignee_display_name: row.users?.name || row.assigned_to || joinedNames,
  };
}

function colorForStatus(wo, woConflicts) {
  if (!wo) return null;
  if (!wo.assigned_to_user_id && !wo.assigned_to && (!wo.work_order_assignees || wo.work_order_assignees.length === 0)) return null; // unassigned = hatched
  // Urgent: has conflicts, or in_progress but past scheduled_end_time
  if (woConflicts && woConflicts[wo.id] && woConflicts[wo.id].length > 0) return STATUS_COLORS.urgent;
  if (wo.status === 'in_progress' && wo.scheduled_end_time) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const ep = wo.scheduled_end_time.split(':');
    const endMin = parseInt(ep[0], 10) * 60 + parseInt(ep[1], 10);
    if (endMin < nowMin) return STATUS_COLORS.urgent;
  }
  return STATUS_COLORS[wo.status] || '#888';
}
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

async function workerScope(req) {
  if (req.session?.role !== 'worker') return null;
  let userName = '';
  const { data: user, error } = await supabase.from('users').select('name').eq('id', req.session.userId).maybeSingle();
  if (error) throw error;
  userName = user?.name || '';
  return { userId: req.session.userId, userName };
}

function applyWorkerScope(query, scope) {
  if (!scope) return query;
  // Option A: two-step query — fetch WO IDs from work_order_assignees first,
  // then filter work_orders by legacy column OR id.in(...)
  const safeName = sanitizePostgrestSearch(scope.userName);
  const legacyFilter = `assigned_to_user_id.eq.${scope.userId}`;
  const nameFilter = safeName ? `assigned_to.ilike.%${safeName}%` : '';

  // We can't chain .or() across tables in PostgREST, so we apply the
  // legacy filter inline and handle the join-table scope separately.
  if (safeName) {
    // Use or including name filter
    return query.or(`${legacyFilter},${nameFilter}`);
  }
  // Legacy column only for initial filter; work_order_assignees handled by
  // calling code via manual WO ID list if needed
  return query.or(legacyFilter);
}

function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtMonth(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

const HOURS_START = 6, HOURS_END = 20, HOUR_COUNT = 14, TOTAL_MINUTES = 840;

// Build day info array for a date range
function buildDays(startDate, endDate, today) {
  const days = [];
  const s = new Date(startDate + 'T12:00:00');
  const e = new Date(endDate + 'T12:00:00');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    days.push({ date: ds, label: d.toLocaleDateString('en-US', { weekday: 'short' }), num: d.getDate(), isToday: ds === today,
      isThisMonth: d.getMonth() === s.getMonth() });
  }
  return days;
}

router.get('/', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const view = (req.query.view || 'week').trim();
  const rawDate = (req.query.date || '').trim() || today;
  const assigneeFilter = req.query.assignee ? parseInt(req.query.assignee, 10) : null;
  const scope = await workerScope(req);

  let weekStart, weekEnd, days, prevDate, nextDate, prevLabel, nextLabel;

  if (view === 'month') {
    const monthStart = firstOfMonth(rawDate);
    const ms = new Date(monthStart + 'T12:00:00');
    const year = ms.getFullYear();
    const month = ms.getMonth() + 1;
    const daysInM = daysInMonth(year, month);
    const monthEnd = `${year}-${String(month).padStart(2,'0')}-${daysInM}`;

    // Pad to full weeks (Mon-Sun) for 6-row grid
    const gridStart = mondayOfWeek(monthStart);
    const me = new Date(monthEnd + 'T12:00:00');
    // End on Sunday of the week containing monthEnd
    const endDay = me.getDay();
    const gridEnd = new Date(me);
    gridEnd.setDate(gridEnd.getDate() + (endDay === 0 ? 0 : 7 - endDay));
    const gridEndStr = gridEnd.toISOString().slice(0, 10);

    days = buildDays(gridStart, gridEndStr, today);

    // Prev/next month
    const pm = new Date(ms);
    pm.setMonth(pm.getMonth() - 1);
    const nm = new Date(ms);
    nm.setMonth(nm.getMonth() + 1);
    prevDate = pm.toISOString().slice(0, 10);
    nextDate = nm.toISOString().slice(0, 10);
    prevLabel = fmtMonth(pm.toISOString().slice(0, 10));
    nextLabel = fmtMonth(nm.toISOString().slice(0, 10));
    weekStart = gridStart;
    weekEnd = gridEndStr;
  } else {
    weekStart = mondayOfWeek(rawDate);
    const ws = new Date(weekStart + 'T12:00:00');
    if (view === '2week') {
      const we = new Date(ws);
      we.setDate(we.getDate() + 13);
      weekEnd = we.toISOString().slice(0, 10);
    } else {
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      weekEnd = we.toISOString().slice(0, 10);
    }
    days = buildDays(weekStart, weekEnd, today);

    const p = new Date(ws);
    p.setDate(p.getDate() - (view === '2week' ? 14 : 7));
    const n = new Date(ws);
    n.setDate(n.getDate() + (view === '2week' ? 14 : 7));
    prevDate = p.toISOString().slice(0, 10);
    nextDate = n.toISOString().slice(0, 10);
    prevLabel = fmtDate(prevDate);
    nextLabel = fmtDate(nextDate);
  }

  // Query WOs in range
  let woQuery = supabase
    .from('work_orders')
    .select(WORK_ORDER_CUSTOMER_SELECT)
    .gte('scheduled_date', weekStart)
    .lte('scheduled_date', weekEnd)
    .in('status', ['scheduled', 'in_progress'])
    .order('scheduled_date', { ascending: true })
    .order('scheduled_time', { ascending: true, nullsFirst: false })
    .order('display_number', { ascending: true });

  if (scope) {
    woQuery = applyWorkerScope(woQuery, scope);
  } else if (assigneeFilter) {
    const { data: user, error: assigneeError } = await supabase.from('users').select('name').eq('id', assigneeFilter).maybeSingle();
    if (assigneeError) throw assigneeError;
    // F4: sanitize before interpolating into PostgREST .or() filter.
    const safeName = sanitizePostgrestSearch(user?.name || '');
    const assigneeFilters = [`assigned_to_user_id.eq.${assigneeFilter}`];
    if (safeName) assigneeFilters.push(`assigned_to.ilike.%${safeName}%`);
    woQuery = woQuery.or(assigneeFilters.join(','));
  }

  const { data: wos, error: wosError } = await woQuery;
  if (wosError) throw wosError;

  // Map to flat structure
  const wosMapped = (wos || []).map(mapScheduleWorkOrder);

  // Unscheduled WOs for sidebar
  let unscheduledQuery = supabase
    .from('work_orders')
    .select(WORK_ORDER_CUSTOMER_SELECT)
    .is('scheduled_date', null)
    .in('status', ['scheduled', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(25);
  unscheduledQuery = applyWorkerScope(unscheduledQuery, scope);
  const { data: unscheduled, error: unscheduledError } = await unscheduledQuery;
  if (unscheduledError) throw unscheduledError;

  const unschedMapped = (unscheduled || []).map(mapScheduleWorkOrder);

  // Query closures intersecting the visible range
  const { data: closures, error: closuresError } = await supabase
    .from('closures')
    .select('*')
    .lte('date_start', weekEnd)
    .or(`date_end.gte.${weekStart},date_end.is.null`);
  if (closuresError) throw closuresError;

  // Build date->name map (expands multi-day closures)
  const closureByDate = {};
  (closures || []).forEach(function(c) {
    var end = c.date_end || c.date_start;
    var d = new Date(c.date_start);
    var stop = new Date(end);
    while (d <= stop) {
      closureByDate[d.toISOString().slice(0, 10)] = c.name;
      d.setDate(d.getDate() + 1);
    }
  });

  // Compute conflicts
  const woConflicts = {};
  await Promise.all(wosMapped.map(async (wo) => {
    if (wo.assigned_to_user_id) {
      const conflicts = await scheduling.findScheduleConflicts({
        assignee_user_id: wo.assigned_to_user_id, date: wo.scheduled_date,
        time: wo.scheduled_time, duration_hours: parseInt(process.env.WO_DEFAULT_DURATION_HOURS || '4', 10),
        exclude_wo_id: wo.id,
      });
      if (conflicts.length > 0) woConflicts[wo.id] = conflicts;
    }
  }));

  // Compute overlap groups per day for horizontal slicing
  function toMinutes(t) { if (!t) return 8*60; const p=t.split(':'); return parseInt(p[0],10)*60+parseInt(p[1],10); }
  const woOverlaps = {};
  const wosByDate = {};
  wos.forEach(wo => {
    if (!wosByDate[wo.scheduled_date]) wosByDate[wo.scheduled_date] = [];
    wosByDate[wo.scheduled_date].push(wo);
  });
  Object.values(wosByDate).forEach(dayWos => {
    dayWos.sort((a,b) => { const da = toMinutes(a.scheduled_time), db = toMinutes(b.scheduled_time); return da - db; });
    const n = dayWos.length;
    for (let i = 0; i < n; i++) {
      const aStart = toMinutes(dayWos[i].scheduled_time);
      const aEnd = dayWos[i].scheduled_end_time ? toMinutes(dayWos[i].scheduled_end_time) : aStart + 240;
      let overlapCount = 1, overlapIndex = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const bStart = toMinutes(dayWos[j].scheduled_time);
        const bEnd = dayWos[j].scheduled_end_time ? toMinutes(dayWos[j].scheduled_end_time) : bStart + 240;
        if (aStart < bEnd && bStart < aEnd) {
          if (j < i) overlapIndex++;
          overlapCount++;
        }
      }
      woOverlaps[dayWos[i].id] = { overlapCount, overlapIndex };
    }
  });

  // Hours
  const hours = [];
  for (let h = HOURS_START; h <= HOURS_END; h++) hours.push(h);

  // Now marker
  const now = new Date();
  const nowOffset = ((now.getHours() - HOURS_START) * 60 + now.getMinutes()) / TOTAL_MINUTES * 100;

  // Users filter dropdown
  const { data: users, error: usersError } = await supabase.from('users').select('id, name, role').eq('active', 1).order('name');
  if (usersError) throw usersError;

  // Determine which view template
  const viewMap = { week: 'schedule/week', '2week': 'schedule/2week', month: 'schedule/month' };
  const template = viewMap[view] || 'schedule/week';

  res.render(template, {
    title: 'Schedule', activeNav: 'schedule',
    days, wos: wosMapped, woConflicts, hours, view,
    weekStart, weekEnd,
    prevDate, nextDate, prevLabel, nextLabel,
    today, nowOffset: nowOffset > 0 && nowOffset < 100 ? nowOffset : null,
    assigneeFilter, users: users || [], colorForStatus, getInitials, fmtDate, fmtMonth,
    HOURS_START, HOURS_END, HOUR_COUNT, TOTAL_MINUTES,
    rawDate, woOverlaps, unscheduled: unschedMapped, closures: closures || [], closureByDate,
  });
});

// GET /schedule/conflict-check — check for scheduling conflicts before a drag-drop
router.get('/conflict-check', async (req, res) => {
  const woId = parseInt(req.query.wo_id, 10);
  const date = (req.query.date || '').trim();
  const time = (req.query.time || '').trim();
  const endTime = (req.query.end_time || '').trim();
  if (!woId || !date) return res.json({ conflicts: [] });
  const { data: wo, error: woError } = await supabase.from('work_orders').select('*').eq('id', woId).maybeSingle();
  if (woError) throw woError;
  if (!wo) return res.json({ conflicts: [] });
  const assigneeId = wo.assigned_to_user_id;
  if (!assigneeId) return res.json({ conflicts: [] });
  // Compute end time from provided end_time, or default to time + 4h
  const effectiveEndTime = endTime || computeDefaultEndTime(time || wo.scheduled_time);
  const conflicts = await scheduling.findScheduleConflicts({
    assignee_user_id: assigneeId,
    date,
    time: time || wo.scheduled_time,
    end_time: effectiveEndTime,
    duration_hours: null, // end_time takes priority
    exclude_wo_id: woId,
  });
  res.json({ conflicts: conflicts.map(c => ({
    display_number: c.display_number,
    customer_name: c.customer_name,
    scheduled_time: c.scheduled_time,
    end_time: c.end_time,
    overlap_minutes: c.overlap_minutes,
  })) });
});

function computeDefaultEndTime(timeStr) {
  if (!timeStr) return '12:00';
  const p = timeStr.split(':');
  let h = parseInt(p[0], 10) + 4;
  if (h > 20) h = 20;
  return String(h).padStart(2, '0') + ':' + (p[1] || '00');
}

// POST /schedule/:id/reschedule — reschedule a WO from drag-drop
router.post('/:id/reschedule', async (req, res) => {
  if (req.session?.role === 'worker') return res.status(403).json({ error: 'Manager or admin access required.' });

  const { data: wo, error: findError } = await supabase.from('work_orders').select('*').eq('id', req.params.id).maybeSingle();
  if (findError) throw findError;
  if (!wo) return res.status(404).json({ error: 'Work order not found.' });
  const date = (req.body.scheduled_date || '').trim();
  const time = (req.body.scheduled_time || '').trim();
  const endTime = (req.body.scheduled_end_time || '').trim();
  if (!date) return res.status(400).json({ error: 'scheduled_date is required.' });
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return res.status(400).json({ error: 'Cannot schedule in the past.' });
  if (time && endTime && endTime <= time) return res.status(400).json({ error: 'End time must be after start time.' });
  const isFirstSchedule = !wo.scheduled_date;
  // Audit
  try {
    const { writeAudit } = require('../services/audit');
    writeAudit({
      entityType: 'work_order', entityId: wo.id, action: isFirstSchedule ? 'scheduled' : 'rescheduled',
      before: { scheduled_date: wo.scheduled_date, scheduled_time: wo.scheduled_time, scheduled_end_time: wo.scheduled_end_time },
      after: { scheduled_date: date, scheduled_time: time || null, scheduled_end_time: endTime || null },
      source: 'user', userId: req.session.userId,
    });
  } catch(e) { /* audit best effort */ }
  const { error: updateError } = await supabase
    .from('work_orders')
    .update({ scheduled_date: date, scheduled_time: time || null, scheduled_end_time: endTime || null, updated_at: new Date().toISOString() })
    .eq('id', wo.id);
  if (updateError) throw updateError;
  res.json({ ok: true, scheduled_date: date, scheduled_time: time || null, scheduled_end_time: endTime || null });
});

module.exports = router;
