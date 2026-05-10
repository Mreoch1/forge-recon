/**
 * v0.5 numbering service.
 *
 * One counter (company_settings.next_wo_main_number) drives everything.
 *   * New root WO from a job: main = next_wo_main_number; sub = 0; counter +=1.
 *   * New sub-WO of an existing WO: main = parent's main; sub = max(siblings.sub) + 1.
 *   * Estimate from a WO inherits the WO's display number.
 *   * Invoice from an estimate inherits its display number too.
 *
 * Display: zero-padded "0001-0000". Prefix is added at render time:
 *   WO-0001-0000, EST-0001-0000, INV-0001-0000.
 *
 * Public API:
 *   nextRootWoNumber()           -> { main, sub: 0, display }
 *   nextSubWoNumber(parentWoId)  -> { main, sub, display } (computed inside transaction)
 *   formatDisplay(main, sub)     -> "0001-0000"
 *   estimateDisplay(wo)          -> "EST-0001-0000"
 *   invoiceDisplay(wo)           -> "INV-0001-0000"
 *   woDisplay(main, sub)         -> "WO-0001-0000"
 *
 * Editable numbers: routes can override `display_number` on creation and
 * still write the (main, sub) pair derived from the override. The
 * counter is bumped only when the auto path is used.
 */

const db = require('../db/db');

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function formatDisplay(main, sub) {
  return `${pad(main, 4)}-${pad(sub, 4)}`;
}

function woDisplay(main, sub)       { return `WO-${formatDisplay(main, sub)}`; }
function estimateDisplay(main, sub) { return `EST-${formatDisplay(main, sub)}`; }
function invoiceDisplay(main, sub)  { return `INV-${formatDisplay(main, sub)}`; }

function nextRootWoNumber() {
  return db.transaction(() => {
    const row = db.get('SELECT next_wo_main_number FROM company_settings WHERE id = 1');
    if (!row) throw new Error('company_settings not initialized — run npm run seed');
    const main = row.next_wo_main_number;
    db.run('UPDATE company_settings SET next_wo_main_number = ? WHERE id = 1', [main + 1]);
    return { main, sub: 0, display: formatDisplay(main, 0) };
  });
}

function nextSubWoNumber(parentWoId) {
  const parent = db.get('SELECT id, wo_number_main FROM work_orders WHERE id = ?', [parentWoId]);
  if (!parent) throw new Error('Parent WO not found: ' + parentWoId);
  const main = parent.wo_number_main;
  // Highest existing sub (siblings under same parent's main)
  const row = db.get(
    `SELECT COALESCE(MAX(wo_number_sub), 0) AS max_sub
     FROM work_orders WHERE wo_number_main = ?`,
    [main]
  );
  const sub = (row.max_sub || 0) + 1;
  return { main, sub, display: formatDisplay(main, sub) };
}

/** Parse a "0001-0000" string into { main, sub } or null on bad format. */
function parseDisplay(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,6})-(\d{1,6})$/);
  if (!m) return null;
  return { main: parseInt(m[1], 10), sub: parseInt(m[2], 10) };
}

module.exports = {
  pad, formatDisplay, woDisplay, estimateDisplay, invoiceDisplay,
  nextRootWoNumber, nextSubWoNumber, parseDisplay,
};
