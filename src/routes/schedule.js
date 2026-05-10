/**
 * schedule.js — Schedule week view.
 *
 * GET /schedule — week grid of WOs by scheduled date/time.
 *   ?date=YYYY-MM-DD  (snaps to that week's Monday)
 *   ?assignee=<user_id>  (optional filter)
 */

const express = require('express');
const router = express.Router();
const db = require('../db/db');
const scheduling = require('../services/scheduling');

const PALETTE = [
  '#4A90D9', // cool blue
  '#8BC34A', // warm yellow-green
  '#9C76D9', // lavender
  '#26A69A', // teal
  '#EF7E6B', // coral
  '#A5D6A7', // mint
  '#78909C', // slate
  '#FFCC80', // peach
];

function colorForUser(userId) {
  if (!userId) return null;
  return PALETTE[Number(userId) % PALETTE.length];
}

/**
 * Get the Monday of the week containing `date`.
 */
function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Format a date for display.
 */
function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateFull(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// GET /schedule — week view
router.get('/', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rawDate = (req.query.date || '').trim() || today;
  const weekStart = mondayOfWeek(rawDate);

  // Week end = Sunday (6 days after Monday)
  const ws = new Date(weekStart + 'T12:00:00');
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const weekEnd = we.toISOString().slice(0, 10);

  // Previous/next week
  const prev = new Date(ws);
  prev.setDate(prev.getDate() - 7);
  const next = new Date(ws);
  next.setDate(next.getDate() + 7);

  // Build day columns (Mon-Sun)
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws);
    d.setDate(d.getDate() + i);
    days.push({
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { weekday: 'short' }),
      num: d.getDate(),
      isToday: d.toISOString().slice(0, 10) === today,
    });
  }

  // Query WOs in this week
  const params = [weekStart, weekEnd];
  let assigneeClause = '';
  const assigneeFilter = req.query.assignee ? parseInt(req.query.assignee, 10) : null;
  if (assigneeFilter) {
    assigneeClause = ' AND (w.assigned_to_user_id = ? OR w.assigned_to LIKE ?)';
    params.push(assigneeFilter, `%${db.get('SELECT name FROM users WHERE id = ?', [assigneeFilter])?.name || ''}%`);
  }

  const wos = db.all(`
    SELECT w.id, w.display_number, w.wo_number_main, w.wo_number_sub,
           w.status, w.scheduled_date, w.scheduled_time,
           w.assigned_to_user_id, w.assigned_to,
           j.title AS job_title,
           c.name AS customer_name,
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

  // Compute conflicts per WO (for conflict badges)
  const woConflicts = {};
  wos.forEach(wo => {
    if (wo.assigned_to_user_id) {
      const conflicts = scheduling.findScheduleConflicts({
        assignee_user_id: wo.assigned_to_user_id,
        date: wo.scheduled_date,
        time: wo.scheduled_time,
        duration_hours: parseInt(process.env.WO_DEFAULT_DURATION_HOURS || '4', 10),
        exclude_wo_id: wo.id,
      });
      if (conflicts.length > 0) {
        woConflicts[wo.id] = conflicts;
      }
    }
  });

  // Hour rows 6 AM – 8 PM
  const hours = [];
  for (let h = 6; h <= 20; h++) {
    hours.push(h);
  }

  // Current time marker
  const now = new Date();
  const nowHour = now.getHours();
  const nowMin = now.getMinutes();
  const nowOffset = ((nowHour - 6) * 60 + nowMin) / (14 * 60) * 100; // percent from 6AM to 8PM

  // Users for filter dropdown
  const users = db.all("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE ASC");

  res.render('schedule/week', {
    title: 'Schedule',
    activeNav: 'schedule',
    days,
    wos,
    woConflicts,
    hours,
    weekStart,
    weekEnd,
    prevWeek: prev.toISOString().slice(0, 10),
    nextWeek: next.toISOString().slice(0, 10),
    today,
    nowHour,
    nowMin,
    nowOffset: nowOffset > 0 && nowOffset < 100 ? nowOffset : null,
    assigneeFilter,
    assigneeName: assigneeFilter ? (db.get('SELECT name FROM users WHERE id = ?', [assigneeFilter]) || {}).name || '' : '',
    users,
    colorForUser,
    fmtDate,
    fmtDateFull,
    HOURS_START: 6,
    HOURS_END: 20,
    HOUR_COUNT: 14, // 6 to 20 = 14 hours
    TOTAL_MINUTES: 14 * 60, // 840 min
  });
});

module.exports = router;
