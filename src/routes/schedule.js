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
const db = require('../db/db');
const scheduling = require('../services/scheduling');

const PALETTE = ['#4A90D9','#8BC34A','#9C76D9','#26A69A','#EF7E6B','#A5D6A7','#78909C','#FFCC80'];
function colorForUser(userId) { return userId ? PALETTE[Number(userId) % PALETTE.length] : null; }

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

router.get('/', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const view = (req.query.view || 'week').trim();
  const rawDate = (req.query.date || '').trim() || today;
  const assigneeFilter = req.query.assignee ? parseInt(req.query.assignee, 10) : null;

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
  let params = [weekStart, weekEnd];
  let assigneeClause = '';
  if (assigneeFilter) {
    assigneeClause = ' AND (w.assigned_to_user_id = ? OR w.assigned_to LIKE ?)';
    const uname = (db.get('SELECT name FROM users WHERE id = ?', [assigneeFilter]) || {}).name || '';
    params.push(assigneeFilter, `%${uname}%`);
  }
  const wos = db.all(`
    SELECT w.id, w.display_number, w.status, w.scheduled_date, w.scheduled_time,
           w.assigned_to_user_id, w.assigned_to,
           j.title AS job_title, c.name AS customer_name,
           u.name AS assignee_user_name
    FROM work_orders w
    JOIN jobs j ON j.id = w.job_id
    JOIN customers c ON c.id = j.customer_id
    LEFT JOIN users u ON u.id = w.assigned_to_user_id
    WHERE date(w.scheduled_date) BETWEEN date(?) AND date(?)
      AND w.status IN ('scheduled', 'in_progress')
      ${assigneeClause}
    ORDER BY w.scheduled_date, w.scheduled_time, w.display_number
  `, params);

  // Compute conflicts
  const woConflicts = {};
  wos.forEach(wo => {
    if (wo.assigned_to_user_id) {
      const conflicts = scheduling.findScheduleConflicts({
        assignee_user_id: wo.assigned_to_user_id, date: wo.scheduled_date,
        time: wo.scheduled_time, duration_hours: parseInt(process.env.WO_DEFAULT_DURATION_HOURS || '4', 10),
        exclude_wo_id: wo.id,
      });
      if (conflicts.length > 0) woConflicts[wo.id] = conflicts;
    }
  });

  // Hours
  const hours = [];
  for (let h = HOURS_START; h <= HOURS_END; h++) hours.push(h);

  // Now marker
  const now = new Date();
  const nowOffset = ((now.getHours() - HOURS_START) * 60 + now.getMinutes()) / TOTAL_MINUTES * 100;

  // Users filter dropdown
  const users = db.all("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");

  // Determine which view template
  const viewMap = { week: 'schedule/week', '2week': 'schedule/2week', month: 'schedule/month' };
  const template = viewMap[view] || 'schedule/week';

  res.render(template, {
    title: 'Schedule', activeNav: 'schedule',
    days, wos, woConflicts, hours, view,
    weekStart, weekEnd,
    prevDate, nextDate, prevLabel, nextLabel,
    today, nowOffset: nowOffset > 0 && nowOffset < 100 ? nowOffset : null,
    assigneeFilter, users, colorForUser, fmtDate, fmtMonth,
    HOURS_START, HOURS_END, HOUR_COUNT, TOTAL_MINUTES,
    rawDate,
  });
});

module.exports = router;
