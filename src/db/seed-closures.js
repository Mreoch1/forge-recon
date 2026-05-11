/**
 * seed-closures.js — Seed US federal holidays for the current year.
 * Run: node src/db/seed-closures.js
 * Idempotent — won't duplicate existing closures.
 */
const db = require('../db/db');
async function main() {
  await db.init();
  try { db.run('CREATE TABLE IF NOT EXISTS closures (id INTEGER PRIMARY KEY, date_start TEXT NOT NULL, date_end TEXT, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT \'holiday\', notes TEXT, created_by_user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  } catch(e) { console.error(e.message); }
  const yr = new Date().getFullYear();
  function nthW(y, m, wd, n) {
    var first = new Date(y, m - 1, 1);
    var fd = first.getDay();
    var d = 1 + ((wd - fd + 7) % 7) + (n - 1) * 7;
    if (n === -1) { var last = new Date(y, m, 0); var ld = last.getDay(); d = last.getDate() - ((ld - wd + 7) % 7); }
    return new Date(y, m - 1, d);
  }
  var h = [
    ["New Year's Day", new Date(yr, 0, 1)], ['MLK Day', nthW(yr, 1, 1, 3)],
    ["Presidents' Day", nthW(yr, 2, 1, 3)], ['Memorial Day', nthW(yr, 5, 1, -1)],
    ['Juneteenth', new Date(yr, 5, 19)], ['Independence Day', new Date(yr, 6, 4)],
    ['Labor Day', nthW(yr, 9, 1, 1)], ['Columbus Day', nthW(yr, 10, 1, 2)],
    ['Veterans Day', new Date(yr, 10, 11)], ['Thanksgiving', nthW(yr, 11, 4, 4)],
    ['Day after Thanksgiving', new Date(nthW(yr, 11, 4, 4).getTime() + 86400000)],
    ['Christmas Eve', new Date(yr, 11, 24)], ['Christmas Day', new Date(yr, 11, 25)],
    ["New Year's Eve", new Date(yr, 11, 31)],
  ];
  var count = 0;
  h.forEach(function(item) {
    var ds = item[1].toISOString().slice(0, 10);
    var dup = db.get('SELECT id FROM closures WHERE date_start = ? AND name = ?', [ds, item[0]]);
    if (!dup) {
      db.run("INSERT INTO closures (date_start, name, type, notes) VALUES (?, ?, 'holiday', 'US federal holiday')", [ds, item[0]]);
      count++;
    }
  });
  console.log('Seeded ' + count + ' US federal holidays for ' + yr);
  // Wait for debounced persist to flush
  setTimeout(function() { process.exit(0); }, 200);
}
main().catch(function(e) { console.error(e); process.exit(1); });
