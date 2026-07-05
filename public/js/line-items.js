/**
 * Estimate / WO / Invoice line-item dynamic UI.
 *
 * Hooks onto a <table data-line-items> with rows of class .line-row,
 * and an "Add row" button with [data-add-line]. Each row contains
 * inputs named lines[<idx>][description], lines[<idx>][quantity], etc.
 *
 * On any input change in a line row, recalculates that row's line total
 * and the totals block at the bottom (subtotal / tax / total).
 *
 * D-112: Row computation uses labor + material + markup to derive
 * cost, unit_price, and line_total. The server recalculates everything
 * authoritatively.
 */
(function () {
  'use strict';

  const TABLE_SEL = 'table[data-line-items]';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function fmtMoney(n) {
    const num = Number(n);
    if (!isFinite(num)) return '0.00';
    return num.toFixed(2);
  }

  function numberOr(value, fallback) {
    const num = parseFloat(value);
    return isFinite(num) ? num : fallback;
  }

  function reindexRows(table) {
    const rows = $$('.line-row', table);
    rows.forEach((row, idx) => {
      $$('input, select, textarea', row).forEach(input => {
        if (input.name && input.name.startsWith('lines[')) {
          input.name = input.name.replace(/^lines\[[^\]]+\]/, `lines[${idx}]`);
        }
      });
    });
  }

  // D-112: compute row totals from labor + material + markup directly
  // Also handles bill form: qty × unit_price (when unit_price exists without labor_cost)
  function calcRow(row) {
    const qtyInput = $('[data-field=quantity]', row);
    const laborInput = $('[data-field=labor_cost]', row);
    const materialInput = $('[data-field=material_cost]', row);
    const unitPriceInput = $('[data-field=unit_price]', row);
    const markupInput = $('[data-field=markup_pct]', row);
    const q = numberOr(qtyInput ? qtyInput.value : 0, 0);
    const hasInternalCostFields = !!(laborInput || materialInput);
    const labor = numberOr(laborInput ? laborInput.value : 0, 0);
    const material = numberOr(materialInput ? materialInput.value : 0, 0);
    const unitPrice = numberOr(unitPriceInput ? unitPriceInput.value : 0, 0);
    const markup = numberOr(markupInput ? markupInput.value : 25, 25);
    let cost, p, total;
    if (hasInternalCostFields) {
      // Estimate/WO style: labor + material + markup
      cost = labor + material;
      p = cost * (1 + markup / 100);
      total = q * p;
    } else {
      // Bill form style: qty × unit_price
      cost = q * unitPrice;
      p = unitPrice;
      total = q * unitPrice;
    }
    // Update readonly computed fields for form submission
    const costInput = $('[data-field=cost]', row);
    if (costInput) costInput.value = fmtMoney(cost);
    const priceInput = $('[data-field=unit_price]', row);
    if (priceInput && hasInternalCostFields) priceInput.value = fmtMoney(p);
    const totalInput = $('[data-field=line_total]', row);
    if (totalInput) totalInput.value = fmtMoney(total);
    return total;
  }

  function calcCost(row) {
    const qtyInput = $('[data-field=quantity]', row);
    const laborInput = $('[data-field=labor_cost]', row);
    const materialInput = $('[data-field=material_cost]', row);
    const unitPriceInput = $('[data-field=unit_price]', row);
    const q = numberOr(qtyInput ? qtyInput.value : 0, 0);
    if (!laborInput && !materialInput) return q * numberOr(unitPriceInput ? unitPriceInput.value : 0, 0);
    const labor = numberOr(laborInput ? laborInput.value : 0, 0);
    const material = numberOr(materialInput ? materialInput.value : 0, 0);
    return q * (labor + material);
  }

  function calcAll() {
    const table = $(TABLE_SEL);
    if (!table) return;
    let subtotal = 0;
    let costTotal = 0;
    $$('.line-row', table).forEach(row => {
      subtotal += calcRow(row);
      costTotal += calcCost(row);
    });
    const subEl = $('[data-totals=subtotal]');
    const taxRateEl = $('[data-totals=tax_rate]');
    const taxAmountEl = $('[data-totals=tax_amount]');
    const totalEl = $('[data-totals=total]');
    const profitEl = $('[data-totals=profit]');
    const roiEl = $('[data-totals=roi]');
    const rate = parseFloat(taxRateEl ? taxRateEl.value : 0) || 0;
    const taxAmt = subtotal * (rate / 100);
    const total = subtotal + taxAmt;
    const profit = subtotal - costTotal;
    const roi = costTotal > 0 ? (profit / costTotal) * 100 : null;
    if (subEl) subEl.textContent = fmtMoney(subtotal);
    if (taxAmountEl) taxAmountEl.textContent = fmtMoney(taxAmt);
    if (totalEl) totalEl.textContent = fmtMoney(total);
    if (profitEl) {
      profitEl.textContent = fmtMoney(profit);
      profitEl.classList.toggle('text-green-700', profit >= 0);
      profitEl.classList.toggle('text-recon-red', profit < 0);
    }
    if (roiEl) {
      roiEl.textContent = roi === null ? '--' : `${roi.toFixed(1)}%`;
      roiEl.classList.toggle('text-green-700', roi !== null && roi >= 0);
      roiEl.classList.toggle('text-recon-red', roi !== null && roi < 0);
    }
  }

  function makeRow(template, idx) {
    const row = template.cloneNode(true);
    row.classList.remove('hidden');
    row.removeAttribute('data-template');
    $$('input, select, textarea', row).forEach(input => {
      if (input.name) {
        input.name = input.name.replace(/^lines\[[^\]]+\]/, `lines[${idx}]`);
      }
      if (input.dataset.field === 'quantity') input.value = '1';
      else if (input.dataset.field === 'labor_cost' || input.dataset.field === 'material_cost') input.value = '';
      else if (input.dataset.field === 'markup_pct') input.value = '25';
      else if (input.dataset.field === 'description') input.value = '';
      // cost, unit_price, line_total are readonly computed — leave template defaults
    });
    return row;
  }

  function visibleRows(tbody) {
    return $$('.line-row', tbody).filter(row => !row.hasAttribute('data-template') && !row.classList.contains('hidden'));
  }

  function focusNextLineField(currentField, row, addLine) {
    const table = $(TABLE_SEL);
    if (!table) return;
    const tbody = $('tbody', table);
    if (!tbody) return;
    const rows = visibleRows(tbody);
    const currentIndex = rows.indexOf(row);
    if (currentIndex === -1) return;

    let nextRow = rows[currentIndex + 1];
    if (!nextRow && typeof addLine === 'function') {
      nextRow = addLine();
    }
    if (!nextRow) return;

    const targetField = currentField && currentField.dataset ? currentField.dataset.field : null;
    const nextField = targetField
      ? $(`[data-field="${targetField}"]`, nextRow)
      : $('input:not([type="hidden"]), select, textarea', nextRow);
    const fallback = $('textarea[data-field="description"], input[data-field="description"], input:not([type="hidden"]), select', nextRow);
    const fieldToFocus = nextField || fallback;
    if (fieldToFocus && typeof fieldToFocus.focus === 'function') {
      fieldToFocus.focus();
      if (typeof fieldToFocus.select === 'function') fieldToFocus.select();
    }
  }

  function bindRow(row) {
    const table = $(TABLE_SEL);
    const addLine = table && table._forgeAddLine ? table._forgeAddLine : null;
    $$('input, select', row).forEach(input => {
      input.addEventListener('input', calcAll);
      input.addEventListener('change', calcAll);
    });
    $$('input, select, textarea', row).forEach(input => {
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        if (event.shiftKey && input.tagName === 'TEXTAREA') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (input.type === 'checkbox' || input.type === 'button' || input.type === 'submit') return;
        event.preventDefault();
        focusNextLineField(input, row, addLine);
      });
    });
    const removeBtn = $('[data-remove-line]', row);
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        const table = $(TABLE_SEL);
        if (!table) return;
        const tbody = $('tbody', table);
        const rowsLeft = tbody ? visibleRows(tbody).length : $$('.line-row', table).length;
        if (rowsLeft <= 1) {
          $$('input, select', row).forEach(input => {
            if (input.dataset.field === 'description') input.value = '';
            else if (input.dataset.field === 'quantity') input.value = '1';
            else if (input.dataset.field === 'labor_cost' || input.dataset.field === 'material_cost') input.value = '';
            else if (input.dataset.field === 'markup_pct') input.value = '25';
          });
        } else {
          row.remove();
          reindexRows(table);
        }
        calcAll();
      });
    }
  }

  function init() {
    const table = $(TABLE_SEL);
    if (!table) return;

    const tbody = $('tbody', table);
    const template = $('[data-template]', tbody);

    function addLine() {
      if (!template) return null;
      const idx = visibleRows(tbody).length;
      const row = makeRow(template, idx);
      tbody.insertBefore(row, template);
      bindRow(row);
      calcAll();
      return row;
    }

    table._forgeAddLine = addLine;

    visibleRows(tbody).forEach(bindRow);

    const addBtn = $('[data-add-line]');
    if (addBtn && template) {
      addBtn.addEventListener('click', () => {
        const row = addLine();
        const desc = $('[data-field=description]', row);
        if (desc) desc.focus();
      });
    }

    const taxInput = $('[data-totals=tax_rate]');
    if (taxInput) {
      taxInput.addEventListener('input', calcAll);
      taxInput.addEventListener('change', calcAll);
    }

    calcAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
