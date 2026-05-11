/**
 * schedule-drag.js — Drag-to-reschedule WO blocks on the schedule grid.
 * Pointer events for cross-device (mouse + touch).
 *
 * Supports:
 *   - Week / 2-week views: WO blocks draggable to hour slots
 *   - Month view: WO pills draggable to day cells
 *   - Drop-zone feedback: highlights target slot, floating tooltip
 *   - From-to confirm popup with editable start/end time inputs
 *
 * Data attributes expected on each WO block:
 *   data-wo-id, data-wo-display, data-current-date, data-current-time, data-end-time
 *
 * Grid day columns use data-day-date on the inner day-column div.
 * Month day cells use data-day-date on the .sc-month-day div.
 * Hours derived from row position (6 AM = 0%, each hour = 1/14th of 840min).
 */
(function() {
  'use strict';

  const HOURS_START = 6;
  const TOTAL_MINUTES = 840; // 6 AM to 8 PM

  let dragState = null; // { el, woId, woDisplay, origDate, origTime, origEndTime, origRect, startX, startY, offsetX, offsetY, view }

  // ── Drop zone / tooltip elements ──
  let dropHighlight = null;
  let dropTooltip = null;

  function createDropHighlight() {
    const el = document.createElement('div');
    el.className = 'sc-drop-highlight';
    el.style.cssText = 'position:absolute;left:0;right:0;pointer-events:none;z-index:6;background:rgba(192,32,43,.12);border:1px solid rgba(192,32,43,.3);border-radius:3px;transition:opacity .12s;';
    el.style.display = 'none';
    document.body.appendChild(el);
    dropHighlight = el;
  }

  function createDropTooltip() {
    const el = document.createElement('div');
    el.className = 'sc-drop-tooltip';
    el.style.cssText = 'position:fixed;padding:3px 8px;background:#1a1a1a;color:#fff;font-size:.7rem;border-radius:4px;pointer-events:none;z-index:2001;white-space:nowrap;font-family:ui-monospace,monospace;';
    el.style.display = 'none';
    document.body.appendChild(el);
    dropTooltip = el;
  }

  function showDropHighlight(dayCol, hourPct, heightPct) {
    if (!dropHighlight) createDropHighlight();
    const rect = dayCol.getBoundingClientRect();
    dropHighlight.style.left = rect.left + 'px';
    dropHighlight.style.top = rect.top + hourPct + 'px';
    dropHighlight.style.width = rect.width + 'px';
    dropHighlight.style.height = (heightPct || 40) + 'px';
    dropHighlight.style.display = 'block';
  }

  function hideDropHighlight() {
    if (dropHighlight) dropHighlight.style.display = 'none';
  }

  function showDropTooltip(text, clientX, clientY) {
    if (!dropTooltip) createDropTooltip();
    dropTooltip.textContent = text;
    dropTooltip.style.display = 'block';
    let left = clientX + 12;
    let top = clientY - 22;
    if (left + 200 > window.innerWidth) left = clientX - 180;
    if (top < 4) top = clientY + 12;
    dropTooltip.style.left = left + 'px';
    dropTooltip.style.top = top + 'px';
  }

  function hideDropTooltip() {
    if (dropTooltip) dropTooltip.style.display = 'none';
  }

  // ── Start drag ──
  function startDrag(e, block) {
    e.preventDefault();
    const rect = block.getBoundingClientRect();
    const pt = e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };

    // Determine which view: month uses pills, week/2week uses blocks
    const isMonthView = block.classList.contains('sc-wo-pill') || !!document.querySelector('.sc-month-grid');

    dragState = {
      el: block,
      woId: block.dataset.woId,
      woDisplay: block.dataset.woDisplay,
      origDate: block.dataset.currentDate,
      origTime: block.dataset.currentTime,
      origEndTime: block.dataset.endTime || '',
      origRect: rect,
      offsetX: pt.x - rect.left,
      offsetY: pt.y - rect.top,
      view: isMonthView ? 'month' : 'grid',
    };

    if (isMonthView) {
      // Month pill drag — clone to floating element
      block.style.position = 'fixed';
      block.style.left = (pt.x - dragState.offsetX) + 'px';
      block.style.top = (pt.y - dragState.offsetY) + 'px';
      block.style.width = rect.width + 'px';
      block.style.zIndex = '1000';
      block.style.opacity = '0.85';
      block.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
      block.style.pointerEvents = 'none';
    } else {
      // Week/2-week block drag
      block.style.position = 'fixed';
      block.style.left = (pt.x - dragState.offsetX) + 'px';
      block.style.top = (pt.y - dragState.offsetY) + 'px';
      block.style.width = rect.width + 'px';
      block.style.zIndex = '1000';
      block.style.opacity = '0.85';
      block.style.boxShadow = '0 4px 12px rgba(0,0,0,.2)';
      block.style.pointerEvents = 'none';
    }

    // Create highlight/tooltip elements on first drag
    if (!dropHighlight) createDropHighlight();
    if (!dropTooltip) createDropTooltip();

    document.addEventListener('pointermove', onDrag);
    document.addEventListener('pointerup', endDrag);
  }

  // ── On drag ──
  function onDrag(e) {
    if (!dragState) return;
    const pt = e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
    dragState.el.style.left = (pt.x - dragState.offsetX) + 'px';
    dragState.el.style.top = (pt.y - dragState.offsetY) + 'px';

    // Month view: find day cell
    if (dragState.view === 'month') {
      const dayCell = findMonthDayCell(pt.x, pt.y);
      hideDropHighlight();
      if (dayCell) {
        const dateStr = dayCell.dataset.dayDate;
        if (dateStr) {
          const d = new Date(dateStr + 'T12:00:00');
          const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          showDropTooltip('Drop on ' + label, pt.x, pt.y);
        } else {
          showDropTooltip('Drop to reschedule', pt.x, pt.y);
        }
      } else {
        hideDropTooltip();
      }
      return;
    }

    // Week/2-week: find day column + hour
    const dayCol = findDayColumn(pt.x, pt.y);
    const hour = findHourSlot(pt.y);

    if (dayCol && hour !== null && hour >= HOURS_START && hour <= 20) {
      const dateStr = dayCol.dataset.dayDate;
      const hourPct = ((hour - HOURS_START) / (20 - HOURS_START + 1)) * 100;
      showDropHighlight(dayCol, hourPct + '%', '38px');

      const d = new Date(dateStr + 'T12:00:00');
      const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const h12 = hour % 12 || 12;
      showDropTooltip(dayLabel + ' \u00b7 ' + h12 + ':00 ' + ampm, pt.x, pt.y);
    } else {
      hideDropHighlight();
      hideDropTooltip();
    }
  }

  // ── End drag ──
  function endDrag(e) {
    document.removeEventListener('pointermove', onDrag);
    document.removeEventListener('pointerup', endDrag);
    hideDropHighlight();
    hideDropTooltip();
    if (!dragState) return;

    const pt = e.changedTouches ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY } : { x: e.clientX, y: e.clientY };

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

    if (dragState.view === 'month') {
      // Month view: drop on day cell
      const dayCell = findMonthDayCell(pt.x, pt.y);
      if (!dayCell) {
        dragState = null;
        return;
      }
      const newDate = dayCell.dataset.dayDate;
      if (!newDate) { dragState = null; return; }
      if (newDate === dragState.origDate) { dragState = null; return; }

      // Month drop: default to 08:00-12:00 since no hour slot
      showFromToPopup(block, dragState, newDate, '08:00', '12:00', pt);
      dragState = null;
      return;
    }

    // Week/2-week: find drop target
    const dayCol = findDayColumn(pt.x, pt.y);
    const hour = findHourSlot(pt.y);

    if (!dayCol || hour === null || hour < HOURS_START) {
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

    // Compute end time: preserve existing end, or default to start + 4h
    const origEnd = dragState.origEndTime || addHours(dragState.origTime || '08:00', 4);

    // Show from-to popup with editable times
    showFromToPopup(block, dragState, newDate, newTime, addHours(newTime, 4), pt);
    dragState = null;
  }

  // ── Month day cell finder ──
  function findMonthDayCell(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.classList && cur.classList.contains('sc-month-day')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // ── Week/2-week helpers ──
  function findDayColumn(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.dataset && cur.dataset.dayDate) return cur;
      if (cur.classList && cur.classList.contains('sc-day-col')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findHourSlot(clientY) {
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

  function addHours(timeStr, hours) {
    if (!timeStr) return '12:00';
    const p = timeStr.split(':');
    let h = parseInt(p[0], 10) + hours;
    if (h > 20) h = 20;
    return String(h).padStart(2, '0') + ':' + (p[1] || '00');
  }

  // ── From-to confirm popup (with editable time inputs) ──
  let confirmCard = null;

  function showFromToPopup(block, state, newDate, newTime, endTime, pt) {
    removeConfirmCard();

    // Fetch conflicts first using end time
    fetch(`/schedule/conflict-check?wo_id=${state.woId}&date=${newDate}&time=${newTime}&end_time=${endTime}`)
      .then(r => r.json())
      .then(data => {
        renderFromToPopup(block, state, newDate, newTime, endTime, data.conflicts || [], pt);
      })
      .catch(() => {
        renderFromToPopup(block, state, newDate, newTime, endTime, [], pt);
      });
  }

  function renderFromToPopup(block, state, newDate, newTime, endTime, conflicts, pt) {
    const isSidebar = block.dataset.source === 'sidebar';
    const moveLabel = isSidebar ? 'Schedule' : 'Move';
    const fmtDate = (d) => {
      const dt = new Date(d + 'T12:00:00');
      return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };

    const card = document.createElement('div');
    card.className = 'sc-confirm-card sc-from-to-card';
    card.innerHTML = `
      <div class="scc-header">${moveLabel} WO-${state.woDisplay}?</div>
      <div class="scc-from-to-row">
        <span class="scc-label">Date:</span>
        <span class="scc-date-display">${fmtDate(newDate)}</span>
      </div>
      <div class="scc-from-to-row">
        <span class="scc-label">Start:</span>
        <input type="time" class="scc-time-input" value="${newTime}" step="900">
      </div>
      <div class="scc-from-to-row">
        <span class="scc-label">End:</span>
        <input type="time" class="scc-time-input scc-end-time" value="${endTime}" step="900">
      </div>
      ${conflicts.length > 0 ? '<div class="scc-conflicts">' + conflicts.map(c =>
        `<div class="scc-conflict">&#9888; ${c.customer_name} already has WO-${c.display_number} at ${c.scheduled_time} &ndash; ${c.end_time} (${c.overlap_minutes}min overlap)</div>`
      ).join('') + '</div>' : ''}
      <div class="scc-actions">
        <button class="scc-confirm">Confirm</button>
        <button class="scc-cancel">Cancel</button>
      </div>
    `;

    // Position
    card.style.position = 'fixed';
    let left = pt.x - 160;
    let top = pt.y + 15;
    if (left < 10) left = 10;
    if (top + 240 > window.innerHeight) top = pt.y - 260;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    document.body.appendChild(card);
    confirmCard = card;

    // Events
    card.querySelector('.scc-confirm').addEventListener('click', () => {
      const startInput = card.querySelector('.scc-time-input');
      const endInput = card.querySelector('.scc-end-time');
      const finalStart = startInput ? startInput.value : newTime;
      const finalEnd = endInput ? endInput.value : endTime;

      if (finalEnd && finalStart && finalEnd <= finalStart) {
        alert('End time must be after start time.');
        return;
      }

      fetch(`/schedule/${state.woId}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduled_date: newDate,
          scheduled_time: finalStart,
          scheduled_end_time: finalEnd || null,
        }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            location.reload();
          } else {
            alert('Error: ' + (data.error || 'Unknown'));
            removeConfirmCard();
          }
        })
        .catch(() => { alert('Network error'); removeConfirmCard(); });
    });
    card.querySelector('.scc-cancel').addEventListener('click', removeConfirmCard);

    // Start input change updates end time to keep same duration
    const startInput = card.querySelector('.scc-time-input');
    const endInput = card.querySelector('.scc-end-time');
    if (startInput && endInput) {
      startInput.addEventListener('change', function() {
        // If end is <= new start, bump end to start + 2h
        if (endInput.value <= this.value) {
          const p = this.value.split(':');
          let h = parseInt(p[0], 10) + 2;
          if (h > 20) h = 20;
          endInput.value = String(h).padStart(2, '0') + ':' + (p[1] || '00');
        }
      });
    }
  }

  function removeConfirmCard() {
    if (confirmCard) {
      confirmCard.remove();
      confirmCard = null;
    }
  }

  // ── Init ──
  function init() {
    if (!dropHighlight) createDropHighlight();
    if (!dropTooltip) createDropTooltip();

    // Week/2-week: attach to .sc-wo-block elements
    document.querySelectorAll('.sc-wo-block').forEach(block => {
      block.addEventListener('pointerdown', (e) => startDrag(e, block));
    });

    // Month view: attach to .sc-wo-pill elements
    if (document.querySelector('.sc-month-grid')) {
      document.querySelectorAll('.sc-wo-pill').forEach(pill => {
        if (pill.dataset.woId) {
          pill.style.cursor = 'grab';
          pill.addEventListener('pointerdown', (e) => startDrag(e, pill));
        }
      });
    }

    // Sidebar: attach to .sc-sb-pill elements
    document.querySelectorAll('.sc-sb-pill').forEach(pill => {
      pill.style.cursor = 'grab';
      pill.addEventListener('pointerdown', (e) => startDrag(e, pill));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
