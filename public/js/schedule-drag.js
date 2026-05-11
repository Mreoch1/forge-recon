/**
 * schedule-drag.js — Drag-to-reschedule WO blocks on the schedule grid.
 * Pointer events for cross-device (mouse + touch).
 *
 * Data attributes expected on each WO block:
 *   data-wo-id, data-wo-display, data-current-date, data-current-time
 *
 * Grid day columns use data-day-date on the inner day-column div.
 * Hours derived from row position (6 AM = 0%, each hour = 1/14th of 840min).
 */
(function() {
  'use strict';

  const HOURS_START = 6;
  const TOTAL_MINUTES = 840; // 6 AM to 8 PM

  let dragState = null; // { el, woId, woDisplay, origDate, origTime, origRect, startX, startY, offsetX, offsetY }

  // Create the floating clone
  function startDrag(e, block) {
    e.preventDefault();
    const rect = block.getBoundingClientRect();
    const pt = e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };

    dragState = {
      el: block,
      woId: block.dataset.woId,
      woDisplay: block.dataset.woDisplay,
      origDate: block.dataset.currentDate,
      origTime: block.dataset.currentTime,
      origRect: rect,
      offsetX: pt.x - rect.left,
      offsetY: pt.y - rect.top,
    };

    block.style.position = 'fixed';
    block.style.left = (pt.x - dragState.offsetX) + 'px';
    block.style.top = (pt.y - dragState.offsetY) + 'px';
    block.style.width = rect.width + 'px';
    block.style.zIndex = '1000';
    block.style.opacity = '0.85';
    block.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
    block.style.pointerEvents = 'none';

    document.addEventListener('pointermove', onDrag);
    document.addEventListener('pointerup', endDrag);
  }

  function onDrag(e) {
    if (!dragState) return;
    const pt = e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
    dragState.el.style.left = (pt.x - dragState.offsetX) + 'px';
    dragState.el.style.top = (pt.y - dragState.offsetY) + 'px';
  }

  function endDrag(e) {
    document.removeEventListener('pointermove', onDrag);
    document.removeEventListener('pointerup', endDrag);
    if (!dragState) return;

    const pt = e.changedTouches ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY } : { x: e.clientX, y: e.clientY };

    // Find drop target day column + hour
    const dayCol = findDayColumn(pt.x, pt.y);
    const hour = findHourSlot(pt.y);

    // Restore block
    const block = dragState.el;
    block.style.position = '';
    block.style.left = '';
    block.style.top = '';
    block.style.width = '';
    block.style.zIndex = '';
    block.style.opacity = '';
    block.style.boxShadow = '';
    block.style.pointerEvents = '';

    if (!dayCol || hour === null) {
      // Dropped outside grid — snap back
      dragState = null;
      return;
    }

    const newDate = dayCol.dataset.dayDate;
    const newTime = String(hour).padStart(2, '0') + ':00';

    // If same slot, no-op
    if (newDate === dragState.origDate && newTime === (dragState.origTime || '08:00')) {
      dragState = null;
      return;
    }

    // Show confirm card
    showConfirmCard(block, dragState, newDate, newTime, pt);
    dragState = null;
  }

  function findDayColumn(clientX, clientY) {
    // Hit-test: find the element under the cursor that has data-day-date
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    // Walk up to find a day column
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.dataset && cur.dataset.dayDate) return cur;
      // Also check if it's an <a> inside a day column — walk up to the day column
      if (cur.classList && cur.classList.contains('sc-day-col')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findHourSlot(clientY) {
    // Walk day columns to find the first one's bounding rect, then compute hour from relative Y
    const dayCols = document.querySelectorAll('.sc-day-col');
    if (dayCols.length === 0) return null;
    const firstCol = dayCols[0];
    const colRect = firstCol.getBoundingClientRect();
    const relY = clientY - colRect.top;
    const pct = relY / colRect.height;
    const minutesFrom6am = pct * TOTAL_MINUTES;
    const hour = Math.round(minutesFrom6am / 60) + HOURS_START;
    return Math.max(HOURS_START, Math.min(20, hour));
  }

  // ── Confirm card ──

  let confirmCard = null;

  function showConfirmCard(block, state, newDate, newTime, pt) {
    removeConfirmCard();

    // Fetch conflicts first, then render card
    fetch(`/schedule/conflict-check?wo_id=${state.woId}&date=${newDate}&time=${newTime}`)
      .then(r => r.json())
      .then(data => {
        renderConfirmCard(block, state, newDate, newTime, data.conflicts || [], pt);
      })
      .catch(() => {
        renderConfirmCard(block, state, newDate, newTime, [], pt);
      });
  }

  function renderConfirmCard(block, state, newDate, newTime, conflicts, pt) {
    const fmtTime = (t) => {
      if (!t) return 'All day';
      const p = t.split(':');
      const h = parseInt(p[0], 10);
      const m = p[1] || '00';
      const ampm = h >= 12 ? 'PM' : 'AM';
      return ((h % 12) || 12) + ':' + m + ' ' + ampm;
    };
    const fmtDate = (d) => {
      const dt = new Date(d + 'T12:00:00');
      return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };

    const card = document.createElement('div');
    card.className = 'sc-confirm-card';
    card.innerHTML = `
      <div class="scc-header">Move WO-${state.woDisplay}?</div>
      <div class="scc-row"><span class="scc-label">From:</span> ${fmtDate(state.origDate)} &middot; ${fmtTime(state.origTime)}</div>
      <div class="scc-row"><span class="scc-label">To:</span> ${fmtDate(newDate)} &middot; ${fmtTime(newTime)}</div>
      ${conflicts.length > 0 ? '<div class="scc-conflicts">' + conflicts.map(c =>
        `<div class="scc-conflict">&#9888; ${c.customer_name} already has WO-${c.display_number} at ${c.scheduled_time} (${c.overlap_minutes}min)</div>`
      ).join('') + '</div>' : ''}
      <div class="scc-actions">
        <button class="scc-confirm">Confirm</button>
        <button class="scc-cancel">Cancel</button>
      </div>
    `;

    // Position near drop point
    card.style.position = 'fixed';
    let left = pt.x - 160;
    let top = pt.y + 15;
    if (left < 10) left = 10;
    if (top + 200 > window.innerHeight) top = pt.y - 210;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    document.body.appendChild(card);
    confirmCard = card;

    // Events
    card.querySelector('.scc-confirm').addEventListener('click', () => {
      fetch(`/schedule/${state.woId}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_date: newDate, scheduled_time: newTime }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            // Reload to show updated position
            location.reload();
          } else {
            alert('Error: ' + (data.error || 'Unknown'));
            removeConfirmCard();
          }
        })
        .catch(() => { alert('Network error'); removeConfirmCard(); });
    });
    card.querySelector('.scc-cancel').addEventListener('click', removeConfirmCard);
  }

  function removeConfirmCard() {
    if (confirmCard) {
      confirmCard.remove();
      confirmCard = null;
    }
  }

  // ── Init ──

  // Add pointer event listeners to all WO blocks (after DOM ready)
  function init() {
    document.querySelectorAll('.sc-wo-block').forEach(block => {
      block.addEventListener('pointerdown', (e) => startDrag(e, block));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
