/**
 * seed-closures.js — Seed US federal holidays for the current year.
 * Run standalone: node src/db/seed-closures.js
 * Also idempotent (won't duplicate).
 */

const db = require('../db/db');
const path = require('path');

async function main() {
  await db.init();
  const year = new Date().getFullYear();

  // Ensure closures table exists
  try {
    db.run(`CREATE TABLE IF NOT EXISTS closures (
      id INTEGER PRIMARY KEY,
      date_start TEXT NOT NULL,
      date_end TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'holiday',
      notes TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch(e) { console.error('Failed to create closures table:', e.message); }

  // Compute floating holidays
  function nthWeekdayOf(year, month, weekday, n) {
    // weekday: 0=Sun, 1=Mon... 6=Sat, n: 1st, 2nd, 3rd... -1=last
    const first = new Date(year, month - 1, 1);
    const firstDay = first.getDay();
    let diff = (weekday - firstDay + 7) % 7;
    let day = 1 + diff + (n - 1) * 7;
    if (n === -1) { // last
      const last = new Date(year, month, 0);
      const lastDay = last.getDay();
      day = last.getDate() - ((lastDay - weekday + 7) % 7);
    }
    return new Date(year, month - 1, day);
  }

  function fmt(d) { return d.toISOString().slice(0, 10); }

  const holidays = [
    { name: "New Year's Day", date: new Date(year, 0, 1) },
    { name: 'Martin Luther King Jr. Day', date: nthWeekdayOf(year, 1, 1, 3) },
    { name: "Presidents' Day", date: nthWeekdayOf(year, 2, 1, 3) },
    { name: 'Memorial Day', date: nthWeekdayOf(year, 5, 1, -1) },
    { name: 'Juneteenth', date: new Date(year, 5, 19) },
    { name: 'Independence Day', date: new Date(year, 6, 4) },
    { name: 'Labor Day', date: nthWeekdayOf(year, 9, 1, 1) },
    { name: 'Columbus Day', date: nthWeekdayOf(year, 10, 1, 2) },
    { name: 'Veterans Day', date: new Date(year, 10, 11) },
    { name: 'Thanksgiving', date: nthWeekdayOf(year, 11, 4, 4) },
    { name: 'Day after Thanksgiving', date: new Date(nthWeekdayOf(year, 11, 4, 4).getTime() + 86400000) },
    { name: 'Christmas Eve', date: new Date(year, 11, 24) },
    { name: 'Christmas Day', date: new Date(year, 11, 25) },
    { name: "New Year's Eve", date: new Date(year, 11, 31) },
  ];

  let count = 0;
  holidays.forEach(h => {
    const existing = db.get('SELECT id FROM closures WHERE date_start = ? AND name = ?', [fmt(h.date), h.name]);
    if (!existing) {
      db.run(`INSERT INTO closures (date_start, date_end, name, type, notes) VALUES (?, ?, ?, 'holiday', 'US federal holiday')`,
        [fmt(h.date), null, h.name]);
      count++;
    }
  });

  console.log(`Seeded ${count} US federal holidays for ${year}.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
