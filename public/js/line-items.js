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
  function calcRow(row) {
    const q = parseFloat($('[data-field=quantity]', row).value) || 0;
    const labor = parseFloat($('[data-field=labor_cost]', row).value) || 0;
    const material = parseFloat($('[data-field=material_cost]', row).value) || 0;
    const markup = parseFloat($('[data-field=markup_pct]', row).value) || 25;
    const cost = labor + material;
    const p = cost * (1 + markup / 100);
    const total = q * p;
    // Update readonly computed fields for form submission
    const costInput = $('[data-field=cost]', row);
    if (costInput) costInput.value = fmtMoney(cost);
    const priceInput = $('[data-field=unit_price]', row);
    if (priceInput) priceInput.value = fmtMoney(p);
    const totalInput = $('[data-field=line_total]', row);
    if (totalInput) totalInput.value = fmtMoney(total);
    return total;
  }

  function calcCost(row) {
    const q = parseFloat($('[data-field=quantity]', row).value) || 0;
    const labor = parseFloat($('[data-field=labor_cost]', row).value) || 0;
    const material = parseFloat($('[data-field=material_cost]', row).value) || 0;
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

  function bindRow(row) {
    $$('input, select', row).forEach(input => {
      input.addEventListener('input', calcAll);
      input.addEventListener('change', calcAll);
    });
    const removeBtn = $('[data-remove-line]', row);
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        const table = $(TABLE_SEL);
        if (!table) return;
        const rowsLeft = $$('.line-row', table).length;
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

    $$('.line-row', tbody).forEach(bindRow);

    const addBtn = $('[data-add-line]');
    if (addBtn && template) {
      addBtn.addEventListener('click', () => {
        const idx = $$('.line-row', tbody).length;
        const row = makeRow(template, idx);
        tbody.insertBefore(row, template);
        bindRow(row);
        calcAll();
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
