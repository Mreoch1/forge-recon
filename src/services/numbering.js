/**
 * v0.5 numbering service — converted to Supabase SDK.
 *
 * One counter (company_settings.next_wo_main_number) drives everything.
 *   * New root WO: main = next_wo_main_number; sub = 0; counter +=1.
 *   * New sub-WO: main = parent's main; sub = max(siblings.sub) + 1.
 *   * Estimate from a WO inherits the WO's display number.
 *   * Invoice from an estimate inherits its display number too.
 *
 * Display: zero-padded "0001-0000". Prefix is added at render time:
 *   WO-0001-0000, EST-0001-0000, INV-0001-0000.
 *
 * Public API:
 *   nextRootWoNumber()           -> { main, sub: 0, display }
 *   nextSubWoNumber(parentWoId)  -> { main, sub, display }
 *   formatDisplay(main, sub)     -> "0001-0000"
 *   estimateDisplay(wo)          -> "EST-0001-0000"
 *   invoiceDisplay(wo)           -> "INV-0001-0000"
 *   woDisplay(main, sub)         -> "WO-0001-0000"
 *   parseDisplay(s)              -> { main, sub } | null
 */
const supabase = require('../db/supabase');

function pad(n, width) { return String(n).padStart(width, '0'); }

function formatDisplay(main, sub) { return `${pad(main, 4)}-${pad(sub, 4)}`; }

function woDisplay(main, sub)       { return `WO-${formatDisplay(main, sub)}`; }
function estimateDisplay(main, sub) { return `EST-${formatDisplay(main, sub)}`; }
function invoiceDisplay(main, sub)  { return `INV-${formatDisplay(main, sub)}`; }

async function nextRootWoNumber() {
  const { data: row, error } = await supabase
    .from('company_settings')
    .select('next_wo_main_number')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error('company_settings not initialized — run npm run seed');
  const main = row.next_wo_main_number;
  const { error: updateError } = await supabase
    .from('company_settings')
    .update({ next_wo_main_number: main + 1 })
    .eq('id', 1);
  if (updateError) throw updateError;
  return { main, sub: 0, display: formatDisplay(main, 0) };
}

async function nextSubWoNumber(parentWoId) {
  const { data: parent, error: findError } = await supabase
    .from('work_orders')
    .select('id, wo_number_main')
    .eq('id', parentWoId)
    .maybeSingle();
  if (findError) throw findError;
  if (!parent) throw new Error('Parent WO not found: ' + parentWoId);
  const main = parent.wo_number_main;
  const { data: rows } = await supabase
    .from('work_orders')
    .select('wo_number_sub')
    .eq('wo_number_main', main)
    .order('wo_number_sub', { ascending: false })
    .limit(1);
  const maxSub = (rows && rows[0]) ? rows[0].wo_number_sub : 0;
  const sub = (maxSub || 0) + 1;
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
