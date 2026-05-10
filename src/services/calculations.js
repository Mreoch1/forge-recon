/**
 * Server-side authoritative calculations for estimates / work orders / invoices.
 *
 * Tax rate is stored as a percentage value (7.5 means 7.5%).
 *
 * Numbers are rounded to 2 decimal places at every step using money-safe
 * integer arithmetic. Don't trust client-submitted line_total or total
 * fields — always recompute on the server before persisting.
 */

function round2(n) {
  // Avoid floating-point drift by going via integer cents.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function lineTotal({ quantity, unit_price }) {
  const q = parseFloat(quantity);
  const p = parseFloat(unit_price);
  if (!isFinite(q) || !isFinite(p)) return 0;
  return round2(q * p);
}

function totals(lineItems, taxRate) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const subtotal = round2(items.reduce((s, li) => s + lineTotal(li), 0));
  const rate = parseFloat(taxRate);
  const ratePct = isFinite(rate) ? rate : 0;
  const taxAmount = round2(subtotal * (ratePct / 100));
  const total = round2(subtotal + taxAmount);
  return { subtotal, taxAmount, total };
}

module.exports = { lineTotal, totals, round2 };
