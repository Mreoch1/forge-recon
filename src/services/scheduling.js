/**
 * scheduling.js — Schedule conflict detection for work orders.
 *
 * Used by AI mutation tools to detect overlapping assignments before
 * scheduling, rescheduling, or assigning a WO to a worker.
 */

const supabase = require('../db/supabase');

/**
 * Find schedule conflicts for a proposed assignment.
 *
 * @param {Object} opts
 * @param {number}  opts.assignee_user_id — DB user id of the assignee (null/0 = no conflict check)
 * @param {string}  opts.date — ISO date string (YYYY-MM-DD)
 * @param {string}  [opts.time] — HH:MM time string (optional, treated as all-day if omitted)
 * @param {string}  [opts.end_time] — HH:MM end time string (if provided, used for overlap calculation instead of duration_hours)
 * @param {number}  [opts.duration_hours=4] — Duration of the proposed block (only used if end_time not provided)
 * @param {number}  [opts.exclude_wo_id] — WO id to exclude (for reschedule — don't conflict-check against self)
 * @returns {Array<Object>} Array of conflict objects:
 *   { wo_id, display_number, customer_name, scheduled_time, end_time, duration_hours, overlap_minutes }
 */
async function findScheduleConflicts({ assignee_user_id, date, time, end_time, duration_hours = 4, exclude_wo_id = null }) {
  if (!assignee_user_id || assignee_user_id <= 0) {
    return [];
  }

  const { data: user } = await supabase
    .from('users')
    .select('name')
    .eq('id', assignee_user_id)
    .maybeSingle();
  const userName = (user?.name || '').toLowerCase();

  let query = supabase
    .from('work_orders')
    .select(`
      id, display_number, scheduled_date, scheduled_time, scheduled_end_time,
      assigned_to_user_id, assigned_to,
      jobs!left(title, customers!left(name)),
      customers!left(name),
      work_order_assignees(user_id)
    `)
    .eq('scheduled_date', date)
    .in('status', ['scheduled', 'in_progress'])
    .order('scheduled_time', { ascending: true });
  if (exclude_wo_id) query = query.neq('id', exclude_wo_id);

  const { data, error } = await query;
  if (error) throw error;

  const conflicts = (data || []).filter(wo => {
    if (Number(wo.assigned_to_user_id) === Number(assignee_user_id)) return true;
    if (userName && String(wo.assigned_to || '').toLowerCase().includes(userName)) return true;
    return (wo.work_order_assignees || []).some(a => Number(a.user_id) === Number(assignee_user_id));
  }).map(wo => ({
    ...wo,
    customer_name: wo.customers?.name || wo.jobs?.customers?.name || '',
  }));

  if (!conflicts || conflicts.length === 0) return [];

  return conflicts.map(wo => {
    const woTime = wo.scheduled_time || '08:00';
    const woEndTime = wo.scheduled_end_time || addHours(woTime, 4);
    const proposedStart = timeToMinutes(time || '08:00');
    const proposedEnd = end_time
      ? timeToMinutes(end_time)
      : proposedStart + (duration_hours || 4) * 60;
    const conflictStart = timeToMinutes(woTime);
    const conflictEnd = timeToMinutes(woEndTime);

    const overlap = Math.min(proposedEnd, conflictEnd) - Math.max(proposedStart, conflictStart);
    const overlapMinutes = Math.max(0, overlap);

    if (overlapMinutes <= 0) return null; // no overlap

    return {
      wo_id: wo.id,
      display_number: wo.display_number,
      customer_name: wo.customer_name || '',
      scheduled_time: woTime,
      end_time: woEndTime,
      duration_hours: Math.round((timeToMinutes(woEndTime) - timeToMinutes(woTime)) / 60),
      overlap_minutes: overlapMinutes
    };
  }).filter(Boolean);
}

/**
 * Convert a time string to total minutes since midnight.
 * @param {string} timeStr — "HH:MM" or undefined/null
 * @returns {number}
 */
function timeToMinutes(timeStr) {
  if (!timeStr) return 8 * 60; // default 8:00 AM
  const parts = timeStr.split(':');
  if (parts.length < 2) return 8 * 60;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/**
 * Parse a date/time string from a user message.
 * Supports:
 *   - ISO: "2026-05-14"
 *   - Slash: "5/14", "05/14/2026"
 *   - Named: "Thursday", "tomorrow", "next Monday"
 *   - Month-day: "May 14", "May 14th"
 *
 * @param {string} text
 * @returns {string|null} YYYY-MM-DD or null if unparseable
 */
function parseDate(text) {
  if (!text) return null;

  const clean = text.trim();

  // ISO date: 2026-05-14
  const iso = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = String(iso[2]).padStart(2, '0');
    const d = String(iso[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Slash format: 5/14 or 05/14/2026
  const slash = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (slash) {
    const now = new Date();
    const year = slash[3] ? parseInt(slash[3], 10) : now.getFullYear();
    const m = String(slash[1]).padStart(2, '0');
    const d = String(slash[2]).padStart(2, '0');
    return `${year}-${m}-${d}`;
  }

  // Month day: "May 14", "May 14th"
  const months = ['january', 'february', 'march', 'april', 'may', 'june',
                  'july', 'august', 'september', 'october', 'november', 'december'];
  const monthDay = clean.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (monthDay) {
    const monthName = monthDay[1].toLowerCase();
    const monthIndex = months.indexOf(monthName);
    if (monthIndex >= 0) {
      const now = new Date();
      const day = parseInt(monthDay[2], 10);
      // Try current year first; if past, use next year
      let year = now.getFullYear();
      const candidate = new Date(year, monthIndex, day);
      // If the date is more than 90 days in the past, try next year
      if ((now - candidate) > 90 * 24 * 60 * 60 * 1000) {
        year += 1;
      }
      const m = String(monthIndex + 1).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      return `${year}-${m}-${d}`;
    }
  }

  // Named day: "Thursday", "next Monday", "tomorrow"
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const now = new Date();

  // "tomorrow"
  if (/^tomorrow$/i.test(clean)) {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return toISODate(t);
  }

  // "next Monday", "next Tuesday", etc.
  const nextDay = clean.match(/^next\s+([A-Za-z]+)$/i);
  if (nextDay) {
    const targetDay = dayNames.indexOf(nextDay[1].toLowerCase());
    if (targetDay >= 0) {
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7; // next week
      const t = new Date(now);
      t.setDate(t.getDate() + daysUntil);
      return toISODate(t);
    }
  }

  // Plain day name: "Thursday" — find next occurrence
  const plainDay = clean.match(/^([A-Za-z]+)$/i);
  if (plainDay) {
    const targetDay = dayNames.indexOf(plainDay[1].toLowerCase());
    if (targetDay >= 0) {
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0) daysUntil += 7; // next week if today is past
      if (daysUntil === 0) daysUntil = 7; // if today, next week
      const t = new Date(now);
      t.setDate(t.getDate() + daysUntil);
      return toISODate(t);
    }
  }

  // Weekday + Month Day: "Thursday June 2", "Tuesday, June 2nd", "Tuesday June 2 at 8am"
  const weekdayMonthDay = clean.match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+at\s+.+)?$/i);
  // Try with weekday prefix: "Tuesday June 2"
  let wdMatch = weekdayMonthDay;
  if (!wdMatch) {
    wdMatch = clean.match(/^[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+at\s+.+)?$/i);
  }
  if (wdMatch) {
    const monthName = wdMatch[1].toLowerCase();
    const monthIndex = months.indexOf(monthName);
    if (monthIndex >= 0) {
      const year = now.getFullYear();
      const day = parseInt(wdMatch[2], 10);
      const m = String(monthIndex + 1).padStart(2, '0');
      const d = String(day).padStart(2, '0');
      return `${year}-${m}-${d}`;
    }
  }

  return null;
}

/**
 * Parse a time string from a user message.
 * Supports: "9am", "9:00 AM", "09:00", "9am", "1pm"
 * @param {string} text
 * @returns {string|null} HH:MM or null
 */
function parseTime(text) {
  if (!text) return null;
  const clean = text.trim();

  // HH:MM AM/PM
  const amp = clean.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (amp) {
    let h = parseInt(amp[1], 10);
    const m = amp[2];
    if (amp[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (amp[3].toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  // HH:MM (24h)
  const h24 = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    return `${String(h24[1]).padStart(2, '0')}:${h24[2]}`;
  }

  // 9am, 1pm (no minutes)
  const hOnly = clean.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (hOnly) {
    let h = parseInt(hOnly[1], 10);
    if (hOnly[2].toLowerCase() === 'pm' && h < 12) h += 12;
    if (hOnly[2].toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:00`;
  }

  return null;
}

/**
 * Format a date for display.
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string} "Thursday, May 14"
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Format a time for display.
 * @param {string} timeStr HH:MM
 * @returns {string} "9:00 AM" or "All day"
 */
function formatTime(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1] || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

/**
 * Resolve a user name to a user record.
 * Fuzzy matches against users table (active=1).
 * Returns:
 *   - { user: {...} } if exact or single match
 *   - { matches: [...] } if multiple matches
 *   - { error: 'msg' } if no match
 */
async function resolveUserName(nameText) {
  if (!nameText || !nameText.trim()) {
    return { error: 'No name provided.' };
  }
  const clean = nameText.trim();

  // Try exact match first (full name or email prefix)
  let user = await db.get('SELECT id, name, email, role FROM users WHERE active = 1 AND (LOWER(name) = LOWER(?) OR LOWER(email) = LOWER(?) )', [clean, clean]);
  if (user) return { user };

  // Try partial match
  const like = `%${clean}%`;
  const matches = await db.all('SELECT id, name, email, role FROM users WHERE active = 1 AND (LOWER(name) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?))', [like, like]);

  if (!matches || matches.length === 0) {
    return { error: `I couldn't find a user matching "${clean}". Try a full name or check /admin/users.` };
  }
  if (matches.length === 1) {
    return { user: matches[0] };
  }
  return { matches };
}

/**
 * Resolve a WO display number (e.g. "0007-0000") to its DB id.
 * Also accepts a raw id number.
 * Returns the WO row or null.
 */
async function resolveWorkOrder(identifier) {
  if (!identifier) return null;
  // Try DB id first
  if (typeof identifier === 'number' || /^\d+$/.test(String(identifier))) {
    const wo = await db.get('SELECT * FROM work_orders WHERE id = ?', [Number(identifier)]);
    if (wo) return wo;
  }
  // Try display number
  return await db.get('SELECT * FROM work_orders WHERE display_number = ?', [String(identifier)]);
}

function addHours(timeStr, hours) {
  if (!timeStr) return '12:00';
  const p = timeStr.split(':');
  let h = parseInt(p[0], 10) + hours;
  if (h > 20) h = 20;
  return String(h).padStart(2, '0') + ':' + (p[1] || '00');
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = {
  findScheduleConflicts,
  parseDate,
  parseTime,
  formatDate,
  formatTime,
  resolveUserName,
  resolveWorkOrder
};
