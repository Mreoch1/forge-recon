/**
 * Atomic numbering service for estimates / WOs / invoices.
 *
 * Each entity has its own counter in company_settings (next_estimate_number,
 * next_wo_number, next_invoice_number). nextNumber(field) reads + increments
 * inside a transaction so two concurrent creates can't collide.
 *
 * Format: PREFIX-YYYY-NNNN with 4-digit zero-padded sequence.
 *   Estimate -> EST-2026-0001
 *   WO       -> WO-2026-0001
 *   Invoice  -> INV-2026-0001
 *
 * Counters do NOT auto-reset on year change in v0 — they're monotonic
 * forever per type. Year resets are listed in TODO_FOR_MICHAEL.md.
 */

const db = require('../db/db');

const VALID_FIELDS = new Set([
  'next_estimate_number',
  'next_wo_number',
  'next_invoice_number',
]);

function nextNumber(field) {
  if (!VALID_FIELDS.has(field)) {
    throw new Error(`Invalid numbering field: ${field}`);
  }
  return db.transaction(() => {
    const row = db.get('SELECT * FROM company_settings WHERE id = 1');
    if (!row) throw new Error('company_settings not initialized — run npm run seed');
    const n = row[field];
    db.run(`UPDATE company_settings SET ${field} = ? WHERE id = 1`, [n + 1]);
    return n;
  });
}

function format(prefix, n) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

module.exports = {
  nextEstimateNumber: () => format('EST', nextNumber('next_estimate_number')),
  nextWONumber:       () => format('WO',  nextNumber('next_wo_number')),
  nextInvoiceNumber:  () => format('INV', nextNumber('next_invoice_number')),
  // exposed for tests
  _nextNumber: nextNumber,
  _format: format,
};
