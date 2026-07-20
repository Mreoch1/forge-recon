'use strict';

function toNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Sum approved RFP scope once. A parent with sub-lines is a display rollup,
 * so its stored totals must not be added alongside its approved children.
 */
function aggregateApprovedRfpFinancials(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const childrenByParent = new Map();

  items.forEach((item) => {
    if (item.parent_line_item_id == null) return;
    const parentId = String(item.parent_line_item_id);
    const children = childrenByParent.get(parentId) || [];
    children.push(item);
    childrenByParent.set(parentId, children);
  });

  return items.reduce((totals, item) => {
    if (item.parent_line_item_id != null) return totals;

    const children = childrenByParent.get(String(item.id)) || [];
    const approvedScope = children.length
      ? children.filter((child) => child.approved === true)
      : (item.approved === true ? [item] : []);

    approvedScope.forEach((line) => {
      totals.cost += toNum(line.total_cost);
      totals.value += toNum(line.total_with_markup);
      totals.lineCount += 1;
    });

    return totals;
  }, { cost: 0, value: 0, lineCount: 0 });
}

module.exports = { aggregateApprovedRfpFinancials };
