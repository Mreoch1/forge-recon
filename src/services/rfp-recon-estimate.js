const { _internal: rfpMath } = require('./rfp-export');

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(((Number(value) || 0) + Number.EPSILON) * factor) / factor;
}

function approvedPricingLines(item, subItemsMap) {
  const children = (subItemsMap && subItemsMap[item.id]) || [];
  if (children.length) return children.filter(child => !!child.approved);
  return item.approved ? [item] : [];
}

function splitApprovedCost(lines) {
  return lines.reduce((totals, line) => {
    const amount = rfpMath.computedLineTotalCost(line);
    if (line.scope_type === 'supplier') totals.material += amount;
    else totals.labor += amount;
    return totals;
  }, { labor: 0, material: 0 });
}

function buildReconEstimateLines(items, subItemsMap) {
  const parentRows = rfpMath.buildExportRows(items, subItemsMap)
    .filter(row => row.level === 'parent');
  const rowsByItemId = new Map(parentRows.map(row => [String(row.raw.id), row]));
  const lines = [];

  (items || [])
    .filter(item => !item.parent_line_item_id)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0))
    .forEach((item) => {
      const pricingLines = approvedPricingLines(item, subItemsMap);
      if (!pricingLines.length) return;

      const row = rowsByItemId.get(String(item.id));
      if (!row) return;

      const totalCost = Number(row.total_cost) || 0;
      const lineTotal = Number(row.total_with_markup) || 0;
      const rawQuantity = Number(row.qty) || 0;
      const quantity = rawQuantity > 0 ? rawQuantity : (lineTotal !== 0 ? 1 : 0);
      const costPerUnit = quantity > 0 ? totalCost / quantity : 0;
      const unitPrice = quantity > 0 ? lineTotal / quantity : 0;
      const hasChildren = ((subItemsMap && subItemsMap[item.id]) || []).length > 0;
      const costSplit = hasChildren
        ? splitApprovedCost(pricingLines)
        : (item.scope_type === 'supplier'
            ? { labor: 0, material: totalCost }
            : { labor: totalCost, material: 0 });
      const laborCost = quantity > 0 ? costSplit.labor / quantity : 0;
      const materialCost = quantity > 0 ? costSplit.material / quantity : 0;
      const markupPct = totalCost > 0 ? ((lineTotal / totalCost) - 1) * 100 : 0;

      lines.push({
        description: String(item.description || '').trim() || 'RFP scope item',
        quantity: round(quantity, 4),
        unit: 'ea',
        unit_price: round(unitPrice, 6),
        cost: round(costPerUnit, 6),
        line_total: round(lineTotal, 2),
        labor_cost: round(laborCost, 6),
        material_cost: round(materialCost, 6),
        markup_pct: round(markupPct, 6),
        selected: 1,
        sort_order: lines.length,
      });
    });

  return lines;
}

function totalsForReconEstimate(lines, taxRate) {
  const subtotal = round((lines || []).reduce((sum, line) => sum + (Number(line.line_total) || 0), 0), 2);
  const costTotal = round((lines || []).reduce((sum, line) => {
    return sum + (Number(line.cost) || 0) * (Number(line.quantity) || 0);
  }, 0), 2);
  const normalizedTaxRate = Number(taxRate) || 0;
  const taxAmount = round(subtotal * normalizedTaxRate / 100, 2);
  return {
    subtotal,
    costTotal,
    taxRate: normalizedTaxRate,
    taxAmount,
    total: round(subtotal + taxAmount, 2),
  };
}

function workOrderLinesFromEstimateLines(lines) {
  return (lines || []).map(line => ({
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unit_price: line.unit_price,
    cost: line.cost,
    line_total: line.line_total,
    completed: 0,
    sort_order: line.sort_order,
  }));
}

module.exports = {
  buildReconEstimateLines,
  totalsForReconEstimate,
  workOrderLinesFromEstimateLines,
  _internal: { approvedPricingLines, splitApprovedCost, round },
};
