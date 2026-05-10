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
 * The submitted form reuses the existing input names; this script only
 * provides the live-calc UX. The server recalculates everything
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
          // Match digits or __IDX__ (template-leftover) — see makeRow note above.
          input.name = input.name.replace(/^lines\[[^\]]+\]/, `lines[${idx}]`);
        }
      });
    });
  }

  function calcRow(row) {
    const q = parseFloat($('[data-field=quantity]', row).value) || 0;
    const p = parseFloat($('[data-field=unit_price]', row).value) || 0;
    const total = q * p;
    const cell = $('[data-field=line_total]', row);
    if (cell) cell.textContent = fmtMoney(total);
    return total;
  }

  function calcAll() {
    const table = $(TABLE_SEL);
    if (!table) return;
    let subtotal = 0;
    $$('.line-row', table).forEach(row => { subtotal += calcRow(row); });
    const subEl = $('[data-totals=subtotal]');
    const taxRateEl = $('[data-totals=tax_rate]');
    const taxAmountEl = $('[data-totals=tax_amount]');
    const totalEl = $('[data-totals=total]');
    const rate = parseFloat(taxRateEl ? taxRateEl.value : 0) || 0;
    const taxAmt = subtotal * (rate / 100);
    const total = subtotal + taxAmt;
    if (subEl) subEl.textContent = fmtMoney(subtotal);
    if (taxAmountEl) taxAmountEl.textContent = fmtMoney(taxAmt);
    if (totalEl) totalEl.textContent = fmtMoney(total);
  }

  function makeRow(template, idx) {
    const row = template.cloneNode(true);
    row.classList.remove('hidden');
    row.removeAttribute('data-template');
    $$('input, select, textarea', row).forEach(input => {
      if (input.name) {
        // Match either `lines[__IDX__]` (template) or `lines[<digits>]` (live row).
        // Earlier regex only caught digits, so the template's __IDX__ placeholder
        // never got rewritten — new rows submitted as `lines[__IDX__]` and got
        // dropped by Express's body parser. That was the "line items disappear" bug.
        input.name = input.name.replace(/^lines\[[^\]]+\]/, `lines[${idx}]`);
      }
      if (input.dataset.field === 'quantity') input.value = '1';
      else if (input.dataset.field === 'unit_price') input.value = '0';
      else if (input.dataset.field === 'description') input.value = '';
    });
    const totalCell = $('[data-field=line_total]', row);
    if (totalCell) totalCell.textContent = '0.00';
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
          // Don't remove the last row — clear it instead.
          $$('input, select', row).forEach(input => {
            if (input.dataset.field === 'description') input.value = '';
            else if (input.dataset.field === 'quantity') input.value = '1';
            else if (input.dataset.field === 'unit_price') input.value = '0';
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
        // Focus the new row's description for fast entry.
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
