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

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function showStatus(text, type) {
    var status = document.getElementById('rfp-autosave-status');
    if (!status) return;
    status.textContent = text;
    status.className = 'text-xs px-2 ' + (type === 'error' ? 'text-recon-red' : type === 'warning' ? 'text-amber-700' : 'text-recon-fog');
  }

  function showToast(text, type) {
    var el = document.getElementById('rfp-autosave-msg');
    if (!el) return;
    var bg = type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : '#059669';
    el.style.background = bg;
    el.style.color = '#fff';
    el.textContent = text;
    el.style.display = 'block';
    setTimeout(function() {
      el.style.opacity = '0';
      setTimeout(function() { el.style.display = 'none'; el.style.opacity = '1'; }, 300);
    }, 3000);
  }

  function fieldValue(el) {
    if (el.type === 'checkbox') return el.checked ? '1' : '0';
    return el.value;
  }

  function associatedFormData(form) {
    var data = new FormData(form);
    document.querySelectorAll('[form="' + form.id + '"]').forEach(function(el) {
      if (!el.name || el.disabled) return;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
      data.append(el.name, el.value);
    });
    return data;
  }

  function jsonFromResponse(response, fallbackMessage) {
    var type = response.headers.get('content-type') || '';
    if (type.indexOf('application/json') === -1) {
      return response.text().then(function() {
        throw new Error(fallbackMessage || 'Save failed.');
      });
    }
    return response.json();
  }

  function addLineFormHasData(form) {
    if (!form) return false;
    return ['vendor', 'description', 'quantity', 'contractor_cost'].some(function(name) {
      var el = form.querySelector('[name="' + name + '"]');
      return el && String(el.value || '').trim() !== '';
    });
  }

  function liveCalcAttrs(id, field, originalValue) {
    return ' data-rfp-live-calc data-rfp-autosave-item data-item-id="' + escapeHtml(id) + '" data-field="' + escapeHtml(field) + '" data-original-value="' + escapeHtml(originalValue) + '"';
  }

  function renderSavedLine(item, parentItemId) {
    var id = String(item.id);
    var formId = 'rfp-sub-form-' + id;
    var delFormId = 'rfp-sub-del-' + id;
    var scopeType = item.scope_type || 'contractor';
    var approved = !!item.approved;
    var qty = item.quantity == null ? '' : item.quantity;
    var unitCost = item.contractor_cost != null ? item.contractor_cost : '';
    var markup = item.markup_pct != null ? item.markup_pct : 16;
    var gr = item.general_requirements_pct != null ? item.general_requirements_pct : 4;
    var totalCost = Number(item.total_cost || 0);
    var totalWithMarkup = Number(item.total_with_markup || 0);
    var finalUnit = Number(item.final_unit_cost || 0);
    return [
      '<form id="' + formId + '" action="/projects/rfps/items/' + encodeURIComponent(id) + '" method="POST" data-rfp-standalone-sub-form></form>',
      '<div class="rounded border border-recon-mist bg-recon-cloud/5 p-3" data-rfp-pricing-line data-parent-item-id="' + escapeHtml(parentItemId) + '" data-rfp-unit-cost-fallback="' + escapeHtml(item.unit_cost || 0) + '">',
      '<div class="grid min-w-0 gap-3 lg:grid-cols-12 lg:items-end">',
      '<label class="block min-w-0 lg:col-span-2"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Type</span><select form="' + formId + '" name="scope_type" class="input mt-1 w-full text-xs" data-rfp-autosave-item data-item-id="' + id + '" data-field="scope_type" data-original-value="' + escapeHtml(scopeType) + '"><option value="contractor"' + (scopeType === 'contractor' ? ' selected' : '') + '>Contractor / Labor</option><option value="supplier"' + (scopeType === 'supplier' ? ' selected' : '') + '>Supplier / Material</option></select></label>',
      '<label class="block min-w-0 lg:col-span-2"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Company</span><input form="' + formId + '" name="vendor" value="' + escapeHtml(item.vendor || '') + '" class="input mt-1 w-full text-xs" placeholder="Vendor or contractor" list="rfp-line-entity-options" autocomplete="off" data-rfp-autosave-item data-item-id="' + id + '" data-field="vendor" data-original-value="' + escapeHtml(item.vendor || '') + '"></label>',
      '<label class="block min-w-0 lg:col-span-4"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Scope / description</span><textarea form="' + formId + '" name="description" class="input mt-1 w-full resize-y text-xs leading-snug" placeholder="Pricing line description" rows="2" data-autosize data-rfp-autosave-item data-item-id="' + id + '" data-field="description" data-original-value="' + escapeHtml(item.description || '') + '">' + escapeHtml(item.description || '') + '</textarea></label>',
      '<label class="block min-w-0 sm:col-span-1 lg:col-span-1"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Qty</span><input form="' + formId + '" name="quantity" type="number" step="any" value="' + escapeHtml(qty) + '" class="input mt-1 w-full text-right text-xs"' + liveCalcAttrs(id, 'quantity', qty) + '></label>',
      '<label class="block min-w-0 sm:col-span-1 lg:col-span-1"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Unit cost</span><input form="' + formId + '" name="contractor_cost" type="number" step="any" value="' + escapeHtml(unitCost) + '" class="input mt-1 w-full text-right text-xs" placeholder="$ Unit"' + liveCalcAttrs(id, 'contractor_cost', unitCost) + '></label>',
      '<label class="block min-w-0 sm:col-span-1 lg:col-span-1"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">MU%</span><input form="' + formId + '" name="markup_pct" type="number" step="any" value="' + escapeHtml(markup) + '" class="input mt-1 w-full text-right text-xs"' + liveCalcAttrs(id, 'markup_pct', markup) + '></label>',
      '<label class="block min-w-0 sm:col-span-1 lg:col-span-1"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">GR%</span><input form="' + formId + '" name="general_requirements_pct" type="number" step="any" value="' + escapeHtml(gr) + '" class="input mt-1 w-full text-right text-xs"' + liveCalcAttrs(id, 'general_requirements_pct', gr) + '></label>',
      '<div class="min-w-0 lg:col-span-12"><div class="mt-1 flex flex-wrap items-center justify-end gap-x-5 gap-y-3 border-t border-recon-mist pt-3">',
      '<div class="min-w-[7rem] text-right"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Total cost</span><div class="font-semibold" data-rfp-live-total-cost>' + moneyText(totalCost) + '</div></div>',
      '<div class="min-w-[7rem] text-right"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Total w/ MU + GR</span><div class="font-semibold" data-rfp-live-total-with-markup>' + moneyText(totalWithMarkup) + '</div></div>',
      '<div class="min-w-[8rem] text-right"><span class="text-[10px] font-semibold uppercase tracking-wider text-recon-fog">Final unit w/ MU + GR</span><div class="font-semibold" data-rfp-live-final-unit>' + moneyText(finalUnit) + '</div></div>',
      '<label class="flex items-center gap-2"><input form="' + formId + '" type="hidden" name="approved" value="0"><input form="' + formId + '" type="checkbox" name="approved" value="1"' + (approved ? ' checked' : '') + liveCalcAttrs(id, 'approved', approved ? '1' : '0') + '><span class="text-xs">Approved</span></label>',
      '<div class="flex items-center justify-end gap-2"><form id="' + delFormId + '" action="/projects/rfps/items/' + encodeURIComponent(id) + '/delete" method="POST" onsubmit="return confirm(&quot;Delete this vendor/contractor line?&quot;)"></form><button type="submit" form="' + delFormId + '" class="text-recon-fog hover:text-recon-red text-sm">&times;</button></div>',
      '</div></div></div></div>'
    ].join('');
  }

  function resetAddForm(form) {
    form.querySelectorAll('input, textarea, select').forEach(function(el) {
      if (el.name === 'parent_id' || el.name === 'approved') return;
      if (el.name === 'markup_pct') el.value = '16';
      else if (el.name === 'general_requirements_pct') el.value = '4';
      else if (el.name === 'scope_type') el.value = 'contractor';
      else el.value = '';
      if (el.hasAttribute('data-autosize') && typeof window.autosize === 'function') window.autosize(el);
    });
    setMoneyOutput(form.querySelector('[data-rfp-live-total-cost]'), 0);
    setMoneyOutput(form.querySelector('[data-rfp-live-total-with-markup]'), 0);
    setMoneyOutput(form.querySelector('[data-rfp-live-final-unit]'), 0);
  }

  function appendSavedLine(form, item) {
    var parentItemId = form.getAttribute('data-parent-item-id');
    var addBox = form.closest('[id^="add-sub-"]');
    var list = addBox && addBox.previousElementSibling;
    if (!list) return;
    var directPricing = list.querySelector('[data-rfp-direct-pricing]');
    if (directPricing) directPricing.remove();
    var emptyNotice = addBox.parentElement && addBox.parentElement.querySelector('.border-dashed');
    if (emptyNotice) emptyNotice.remove();
    list.insertAdjacentHTML('beforeend', renderSavedLine(item, parentItemId));
    var newForm = document.getElementById('rfp-sub-form-' + item.id);
    bindSavedSubForm(newForm);
    if (typeof window.autosize === 'function') {
      document.querySelectorAll('[data-rfp-autosave-item][data-item-id="' + item.id + '"][data-autosize]').forEach(function(el) { window.autosize(el); });
    }
    updateSummary(parentItemId);
  }

  function saveAutosaveField(el) {
    var itemId = el && el.getAttribute('data-item-id');
    var field = el && el.getAttribute('data-field');
    if (!itemId || !field) return Promise.resolve(null);
    var value = fieldValue(el);
    if (value === (el.dataset.originalValue || '')) return Promise.resolve(null);
    return fetch('/projects/rfps/items/' + encodeURIComponent(itemId) + '/autosave', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: field,
        value: value,
        originalValue: el.dataset.originalValue || ''
      })
    }).then(function(response) {
      return jsonFromResponse(response, 'Pricing line save failed.').then(function(data) {
        if (!response.ok) throw new Error(data && data.error ? data.error : 'Pricing line save failed.');
        if (data && data.item && Object.prototype.hasOwnProperty.call(data.item, field)) {
          value = field === 'approved' ? (data.item[field] ? '1' : '0') : String(data.item[field] == null ? '' : data.item[field]);
          if (el.type === 'checkbox') el.checked = value === '1';
          else el.value = value;
        }
        el.dataset.originalValue = value == null ? '' : String(value);
        el.classList.remove('border-recon-red');
        el.title = '';
        return data;
      });
    });
  }

  function saveAssociatedForm(form) {
    if (!form) return Promise.resolve();
    showStatus('Saving...', 'success');
    var fields = Array.from(document.querySelectorAll('[form="' + form.id + '"][data-rfp-autosave-item]'));
    var saves = fields.map(saveAutosaveField);
    return Promise.all(saves).then(function(results) {
      var associated = document.querySelector('[form="' + form.id + '"][data-rfp-live-calc]');
      recalculateFrom(associated);
      showStatus('Saved just now', 'success');
      return results.filter(Boolean);
    });
  }

  function bindSavedSubForm(form) {
    if (!form || form.dataset.rfpStandaloneSubBound === '1') return;
    form.dataset.rfpStandaloneSubBound = '1';
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      saveAssociatedForm(form).then(function() {
        showToast('Pricing line saved.', 'success');
      }).catch(function(error) {
        showStatus('Save failed', 'error');
        showToast(error && error.message ? error.message : 'Pricing line save failed.', 'error');
      });
    }, true);
  }

  function submitAddLineForm(form) {
    if (!addLineFormHasData(form)) {
      showToast('Add a company, description, qty, or unit cost first.', 'warning');
      return Promise.resolve();
    }
    showStatus('Saving...', 'success');
    return fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { 'X-Requested-With': 'fetch' }
    }).then(function(response) {
      return jsonFromResponse(response, 'Add line failed.').then(function(data) {
        if (!response.ok || !data || !data.item) throw new Error(data && data.error ? data.error : 'Add line failed.');
        appendSavedLine(form, data.item);
        resetAddForm(form);
        showStatus('Saved just now', 'success');
        showToast('Pricing line added.', 'success');
        var nextDescription = form.querySelector('[name="description"]');
        if (nextDescription) nextDescription.focus();
        return data;
      });
    });
  }

  function bindAddLineForm(form) {
    if (!form || form.dataset.rfpStandaloneAddBound === '1') return;
    form.dataset.rfpStandaloneAddBound = '1';
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      submitAddLineForm(form).catch(function(error) {
        showStatus('Save failed', 'error');
        showToast(error && error.message ? error.message : 'Pricing line add failed.', 'error');
      });
    }, true);
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

  document.querySelectorAll('form[id^="rfp-add-sub-form-"]').forEach(bindAddLineForm);
  document.querySelectorAll('form[id^="rfp-sub-form-"]').forEach(bindSavedSubForm);

  window.recalculateRfpPricingLine = recalculateFrom;
  window.updateRfpEditorSummary = window.updateRfpEditorSummary || updateSummary;
  window.submitStandaloneRfpAddLineForm = submitAddLineForm;
})();
