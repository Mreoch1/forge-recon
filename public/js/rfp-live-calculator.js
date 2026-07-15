(function() {
  function moneyText(value) {
    var num = Number(value);
    return '$' + (isFinite(num) ? num : 0).toFixed(2);
  }

  function moneyPlain(value) {
    var num = Number(value);
    return (isFinite(num) ? num : 0).toFixed(2);
  }

  function setMoneyOutput(el, value) {
    if (!el) return;
    if (el.tagName === 'INPUT') el.value = moneyPlain(value);
    else el.textContent = moneyText(value);
  }

  function setPlainOutput(el, value) {
    if (!el) return;
    el.textContent = value == null || value === '' ? '-' : String(value);
  }

  function numberInput(scope, name, fallback) {
    var el = scope && scope.querySelector('[name="' + name + '"]');
    if (!el) return fallback || 0;
    var n = parseFloat(el.value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function numberValue(value, fallback) {
    var n = parseFloat(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function formatPercentValue(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '';
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(4)));
  }

  function percentInput(scope, name, fallback) {
    return formatPercentValue(numberInput(scope, name, fallback));
  }

  function percentSummary(values) {
    var unique = [];
    values.forEach(function(value) {
      if (value !== '' && unique.indexOf(value) === -1) unique.push(value);
    });
    return unique.length ? unique.join(' / ') : '-';
  }

  function liveLineHasData(line) {
    if (!line || !line.hasAttribute('data-rfp-new-line')) return true;
    return ['vendor', 'description', 'quantity', 'contractor_cost'].some(function(name) {
      var el = line.querySelector('[name="' + name + '"]');
      return el && String(el.value || '').trim() !== '';
    });
  }

  function computeLine(line) {
    var qty = numberInput(line, 'quantity', 0);
    var splitUnit = numberInput(line, 'contractor_cost', 0) + numberInput(line, 'vendor_cost', 0);
    var fallbackUnit = numberValue(line && line.getAttribute('data-rfp-unit-cost-fallback'), 0);
    var unit = splitUnit > 0 ? splitUnit : fallbackUnit;
    var markup = numberInput(line, 'markup_pct', 16);
    var gr = numberInput(line, 'general_requirements_pct', 4);
    var totalCost = qty * unit;
    var totalWithMarkup = totalCost * (1 + ((markup + gr) / 100));
    return {
      qty: qty,
      totalCost: totalCost,
      totalWithMarkup: totalWithMarkup,
      finalUnit: qty > 0 ? totalWithMarkup / qty : 0
    };
  }

  function refreshApprovedTotalsFor(el) {
    var table = el && el.closest && el.closest('.rfp-items-table');
    if (!table) return;
    var rfpId = table.getAttribute('data-rfp-id');
    var total = 0;
    var approvedCount = 0;
    table.querySelectorAll('.rfp-li-row').forEach(function(row) {
      var rowTotal = parseFloat(row.getAttribute('data-rfp-line-total')) || 0;
      var checkbox = row.querySelector('input[type="checkbox"][data-field="approved"]');
      if (checkbox) {
        row.setAttribute('data-rfp-line-approved', checkbox.checked ? '1' : '0');
        if (checkbox.checked) {
          total += rowTotal;
          approvedCount += 1;
        }
      } else if (row.getAttribute('data-rfp-line-approved') === '1') {
        approvedCount += 1;
        total += rowTotal;
      }
    });
    var summary = document.querySelector('[data-rfp-summary-total="' + rfpId + '"]');
    var grand = document.querySelector('[data-rfp-grand-total="' + rfpId + '"]');
    var categoryRow = document.querySelector('[data-rfp-category-row][data-rfp-id="' + rfpId + '"]');
    if (categoryRow) categoryRow.setAttribute('data-rfp-approved-count', String(approvedCount));
    if (summary) summary.textContent = moneyText(total);
    if (grand) grand.textContent = moneyText(total);
    if (typeof window.applyRfpFilters === 'function') window.applyRfpFilters();
  }

  function updateSummary(parentItemId) {
    var summary = document.querySelector('[data-rfp-editor-summary="' + parentItemId + '"]');
    if (!summary) return;
    var parentRow = document.getElementById('rfp-line-' + parentItemId);
    var totalCost = 0;
    var totalWithMarkup = 0;
    var qty = 0;
    var approvedTotalCost = 0;
    var approvedTotalWithMarkup = 0;
    var approvedQty = 0;
    var approvedMarkupValues = [];
    var approvedGrValues = [];
    var approvedCount = 0;
    var lineCount = 0;

    document.querySelectorAll('[data-rfp-pricing-line][data-parent-item-id="' + parentItemId + '"]').forEach(function(line) {
      if (!liveLineHasData(line)) return;
      var isNewLine = line.hasAttribute('data-rfp-new-line');
      if (!isNewLine) lineCount += 1;
      var checkbox = line.querySelector('input[type="checkbox"][data-field="approved"]');
      var approved = checkbox ? checkbox.checked : true;
      var computed = computeLine(line);
      setMoneyOutput(line.querySelector('[data-rfp-live-total-cost]'), computed.totalCost);
      setMoneyOutput(line.querySelector('[data-rfp-live-total-with-markup]'), computed.totalWithMarkup);
      setMoneyOutput(line.querySelector('[data-rfp-live-final-unit]'), computed.finalUnit);
      totalCost += computed.totalCost;
      totalWithMarkup += computed.totalWithMarkup;
      qty = Math.max(qty, computed.qty || 0);
      if (approved && !isNewLine) {
        approvedCount += 1;
        approvedTotalCost += computed.totalCost;
        approvedTotalWithMarkup += computed.totalWithMarkup;
        approvedQty = Math.max(approvedQty, computed.qty || 0);
        approvedMarkupValues.push(percentInput(line, 'markup_pct', 16));
        approvedGrValues.push(percentInput(line, 'general_requirements_pct', 4));
      }
    });

    setMoneyOutput(summary.querySelector('[data-rfp-editor-summary-total-cost]'), totalCost);
    setMoneyOutput(summary.querySelector('[data-rfp-editor-summary-total-with-markup]'), totalWithMarkup);
    setMoneyOutput(summary.querySelector('[data-rfp-editor-summary-final-unit]'), qty > 0 ? totalWithMarkup / qty : 0);

    if (!parentRow) return;
    parentRow.setAttribute('data-rfp-line-total', moneyPlain(approvedTotalWithMarkup));
    parentRow.setAttribute('data-rfp-line-approved', approvedCount > 0 ? '1' : '0');
    setPlainOutput(parentRow.querySelector('[data-rfp-parent-qty="' + parentItemId + '"]'), approvedQty || 0);
    setMoneyOutput(parentRow.querySelector('[data-rfp-parent-unit-cost="' + parentItemId + '"]'), approvedQty > 0 ? approvedTotalCost / approvedQty : 0);
    setMoneyOutput(parentRow.querySelector('[data-rfp-parent-total-cost="' + parentItemId + '"]'), approvedTotalCost);
    setPlainOutput(parentRow.querySelector('[data-rfp-parent-markup="' + parentItemId + '"]'), percentSummary(approvedMarkupValues));
    setPlainOutput(parentRow.querySelector('[data-rfp-parent-gr="' + parentItemId + '"]'), percentSummary(approvedGrValues));
    setMoneyOutput(parentRow.querySelector('[data-rfp-parent-total="' + parentItemId + '"]'), approvedTotalWithMarkup);
    setMoneyOutput(parentRow.querySelector('[data-rfp-parent-final-unit="' + parentItemId + '"]'), approvedQty > 0 ? approvedTotalWithMarkup / approvedQty : 0);

    var approvedIcon = parentRow.querySelector('[data-rfp-parent-approved-icon="' + parentItemId + '"]');
    if (approvedIcon) {
      var allApproved = lineCount > 0 && approvedCount === lineCount;
      approvedIcon.textContent = allApproved ? '✓' : '○';
      approvedIcon.classList.toggle('text-green-600', allApproved);
      approvedIcon.classList.toggle('text-recon-fog', !allApproved);
    }
    var lineBadge = parentRow.querySelector('[data-rfp-parent-line-count="' + parentItemId + '"]');
    if (lineBadge) lineBadge.textContent = approvedCount + '/' + lineCount;
    refreshApprovedTotalsFor(parentRow);
  }

  function recalculateFrom(el) {
    var line = el && el.closest && el.closest('[data-rfp-pricing-line]');
    if (!line) return;
    var parentItemId = line.getAttribute('data-parent-item-id');
    if (parentItemId) updateSummary(parentItemId);
  }

  function handle(event) {
    var target = event && event.target;
    var el = target && target.closest && target.closest('[data-rfp-live-calc]');
    if (!el) return;
    recalculateFrom(el);
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function() {
        recalculateFrom(el);
      });
    }
  }

  ['input', 'change', 'keyup', 'mouseup', 'blur'].forEach(function(eventName) {
    document.addEventListener(eventName, handle, true);
  });

  window.recalculateRfpPricingLine = recalculateFrom;
  window.updateRfpEditorSummary = window.updateRfpEditorSummary || updateSummary;
})();
