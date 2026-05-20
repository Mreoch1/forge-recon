/**
 * address-autocomplete.js
 *
 * Attaches an address-suggestion dropdown to any input named "address" inside a
 * <form>. When the user selects a suggestion, sibling inputs named "city",
 * "state", and "zip" within the same form are auto-populated.
 *
 * Zero-config: forms only need consistent input names (already true across
 * FORGE). To opt OUT for a specific input, set `data-no-autocomplete` on it.
 *
 * Backend: /api/address/autocomplete?q=<query>  (see src/routes/api-address.js)
 */
(function () {
  'use strict';

  if (window.__forgeAddressAutocompleteLoaded) return;
  window.__forgeAddressAutocompleteLoaded = true;

  // ---- styles (injected once, scoped via the wrapper class) ----
  const STYLE_ID = 'forge-addr-ac-styles';
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .forge-addr-ac-wrap { position: relative; }
      .forge-addr-ac-list {
        position: absolute; left: 0; right: 0; top: 100%;
        z-index: 60;
        background: #1c1c1f;
        color: #e5e5e7;
        border: 1px solid #3a3a3f;
        border-radius: 6px;
        margin-top: 2px;
        max-height: 280px;
        overflow-y: auto;
        box-shadow: 0 12px 28px rgba(0,0,0,0.45);
        font-size: 13px;
      }
      .forge-addr-ac-item {
        padding: 8px 10px;
        cursor: pointer;
        border-bottom: 1px solid #2a2a2f;
        line-height: 1.3;
      }
      .forge-addr-ac-item:last-child { border-bottom: none; }
      .forge-addr-ac-item.is-active,
      .forge-addr-ac-item:hover { background: #2d2d33; }
      .forge-addr-ac-hint {
        padding: 6px 10px;
        font-size: 11px;
        color: #8a8a90;
        background: #18181b;
        border-bottom: 1px solid #2a2a2f;
      }
    `;
    document.head.appendChild(s);
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      const args = arguments, ctx = this;
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  function findSiblingInForm(form, name) {
    if (!form) return null;
    return form.querySelector(`[name="${name}"]`);
  }

  function attach(input) {
    if (!input || input.dataset.acAttached === '1') return;
    if (input.hasAttribute('data-no-autocomplete')) return;

    const form = input.closest('form');
    if (!form) return;

    input.dataset.acAttached = '1';
    input.setAttribute('autocomplete', 'off');

    // Wrap input so the dropdown can be absolutely positioned beneath it.
    const wrap = document.createElement('div');
    wrap.className = 'forge-addr-ac-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const list = document.createElement('div');
    list.className = 'forge-addr-ac-list';
    list.style.display = 'none';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    let activeIdx = -1;
    let currentResults = [];

    function close() {
      list.style.display = 'none';
      list.innerHTML = '';
      activeIdx = -1;
      currentResults = [];
    }

    function render(results) {
      currentResults = results || [];
      if (!currentResults.length) { close(); return; }
      list.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'forge-addr-ac-hint';
      hint.textContent = 'Suggestions — click to fill';
      list.appendChild(hint);
      currentResults.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'forge-addr-ac-item';
        row.setAttribute('role', 'option');
        row.dataset.idx = String(i);
        row.textContent = r.label || `${r.address || ''} ${r.city || ''}`.trim();
        row.addEventListener('mousedown', (e) => {
          // mousedown so it fires before the blur that would close the list
          e.preventDefault();
          pick(i);
        });
        list.appendChild(row);
      });
      list.style.display = 'block';
      activeIdx = -1;
    }

    function setActive(idx) {
      const rows = list.querySelectorAll('.forge-addr-ac-item');
      rows.forEach((r) => r.classList.remove('is-active'));
      if (idx >= 0 && idx < rows.length) {
        rows[idx].classList.add('is-active');
        rows[idx].scrollIntoView({ block: 'nearest' });
      }
      activeIdx = idx;
    }

    function pick(idx) {
      const r = currentResults[idx];
      if (!r) return;
      input.value = r.address || '';
      const cityEl  = findSiblingInForm(form, 'city');
      const stateEl = findSiblingInForm(form, 'state');
      const zipEl   = findSiblingInForm(form, 'zip');
      if (cityEl  && r.city)  cityEl.value  = r.city;
      if (stateEl && r.state) stateEl.value = r.state;
      if (zipEl   && r.zip)   zipEl.value   = r.zip;
      [input, cityEl, stateEl, zipEl].forEach((el) => {
        if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      close();
    }

    const fetchSuggestions = debounce(async function () {
      const q = input.value.trim();
      if (q.length < 3) { close(); return; }
      try {
        const resp = await fetch(`/api/address/autocomplete?q=${encodeURIComponent(q)}`, {
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) { close(); return; }
        const json = await resp.json();
        render(json.results || []);
      } catch (_e) {
        close();
      }
    }, 280);

    input.addEventListener('input', fetchSuggestions);
    input.addEventListener('focus', function () {
      if (currentResults.length) list.style.display = 'block';
    });
    input.addEventListener('blur', function () {
      // Delay close so click on item registers.
      setTimeout(close, 150);
    });
    input.addEventListener('keydown', function (e) {
      if (list.style.display === 'none') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(Math.min(activeIdx + 1, currentResults.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(Math.max(activeIdx - 1, 0));
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0) {
          e.preventDefault();
          pick(activeIdx);
        }
      } else if (e.key === 'Escape') {
        close();
      }
    });
  }

  function scanAndAttach(root) {
    const inputs = (root || document).querySelectorAll('form input[name="address"]');
    inputs.forEach(attach);
  }

  // Initial pass
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scanAndAttach(document));
  } else {
    scanAndAttach(document);
  }

  // Future-proof: rescan when forms are injected dynamically (e.g., AI preview form).
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes && m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) {
          if (n.matches && n.matches('form input[name="address"]')) attach(n);
          else if (n.querySelectorAll) scanAndAttach(n);
        }
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();
