(function(){
  function formatPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    digits = digits.slice(0, 10);
    if (digits.length > 6) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    if (digits.length > 3) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
    if (digits.length) return '(' + digits;
    return '';
  }

  function isPhoneInput(el) {
    if (!el || !el.matches) return false;
    return el.matches('input[name="phone"], input[data-phone], input[data-phone-format]');
  }

  function applyFormat(el) {
    var next = formatPhone(el.value);
    if (next !== el.value) el.value = next;
  }

  document.addEventListener('input', function(e){
    if (!isPhoneInput(e.target)) return;
    applyFormat(e.target);
  });

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('input[name="phone"], input[data-phone], input[data-phone-format]').forEach(applyFormat);
  });
})();

// RFP parent MU and GR hotfix: derive each displayed parent percentage from
// approved child lines using child total cost as the weighting basis.
(function(){
  function numberValue(scope, name, fallback) {
    var el = scope && scope.querySelector('[name="' + name + '"]');
    if (!el) return fallback || 0;
    var value = parseFloat(el.value);
    return Number.isFinite(value) ? value : (fallback || 0);
  }

  function percentText(value) {
    if (!Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? String(value) : String(parseFloat(value.toFixed(4)));
  }

  function childIsApproved(line) {
    var checkbox = line.querySelector('input[type="checkbox"][data-field="approved"]');
    return checkbox ? checkbox.checked : true;
  }

  function updateParentPercentages(parentId) {
    var parentRow = document.getElementById('rfp-line-' + parentId);
    if (!parentRow) return;

    var totalCost = 0;
    var weightedMarkup = 0;
    var weightedGr = 0;

    document.querySelectorAll('[data-rfp-pricing-line][data-parent-item-id="' + parentId + '"]').forEach(function(line){
      if (line.hasAttribute('data-rfp-new-line') || !childIsApproved(line)) return;
      var qty = numberValue(line, 'quantity', 0);
      var unitCost = numberValue(line, 'contractor_cost', 0) + numberValue(line, 'vendor_cost', 0);
      var cost = qty * unitCost;
      var markup = numberValue(line, 'markup_pct', 16);
      var gr = numberValue(line, 'general_requirements_pct', 4);
      totalCost += cost;
      weightedMarkup += cost * markup;
      weightedGr += cost * gr;
    });

    var cells = parentRow.children;
    if (!cells || cells.length < 6) return;
    cells[4].textContent = totalCost > 0 ? percentText(weightedMarkup / totalCost) : '—';
    cells[5].textContent = totalCost > 0 ? percentText(weightedGr / totalCost) : '—';
  }

  function updateAllParentPercentages() {
    document.querySelectorAll('[data-rfp-editor-summary]').forEach(function(summary){
      updateParentPercentages(summary.getAttribute('data-rfp-editor-summary'));
    });
  }

  document.addEventListener('DOMContentLoaded', updateAllParentPercentages);
  document.addEventListener('input', function(event){
    var line = event.target && event.target.closest && event.target.closest('[data-rfp-pricing-line]');
    if (line) updateParentPercentages(line.getAttribute('data-parent-item-id'));
  });
  document.addEventListener('change', function(event){
    var line = event.target && event.target.closest && event.target.closest('[data-rfp-pricing-line]');
    if (line) updateParentPercentages(line.getAttribute('data-parent-item-id'));
  });
})();
