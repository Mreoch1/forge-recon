/* eslint-env browser */
/**
 * Recon AI Chat — Round 11 Tier 1+2 client widget.
 *
 * Lives in every page footer (mounted via #ai-chat-root).
 * - Floating pill bottom-right when collapsed.
 * - Expands to 380×500 chat panel on click.
 * - POSTs { message, history } to /ai/chat
 * - Renders reply text + clickable navigation chips returned by the server.
 * - History persists in sessionStorage; clears on logout.
 *
 * Pure progressive enhancement: if /ai/chat returns 404 (kill switch),
 * the widget hides itself and never retries this session.
 *
 * Server contract (Round 11 — wired by Hermes):
 *   POST /ai/chat { message: string, history: [{ role, content }] }
 *     → 200 { reply: string, chips: [{label, href}], tool_calls: [...], audit_id }
 *     → 404 { error: 'AI chat disabled' }   (when AI_CHAT_ENABLED=0)
 *     → 5xx { error: string }
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'recon_ai_chat_history_v1';
  const MAX_HISTORY = 20;

  // ----- DOM -----
  const root = document.getElementById('ai-chat-root');
  if (!root) return;

  // Inject styles once.
  if (!document.getElementById('ai-chat-styles')) {
    const style = document.createElement('style');
    style.id = 'ai-chat-styles';
    style.textContent = `
      .recon-aic-pill {
        position: fixed; bottom: 1rem; right: 1rem; z-index: 9000;
        background: #1a1a1a; color: #fff; font-size: .85rem; font-weight: 500;
        padding: .55rem .9rem; border-radius: 999px;
        box-shadow: 0 6px 18px rgba(0,0,0,.18); cursor: pointer;
        display: inline-flex; align-items: center; gap: .5rem;
        border: 1px solid #2d2d2d; transition: all .15s;
        font-family: 'Inter', system-ui, sans-serif;
      }
      .recon-aic-pill:hover { background: #c0202b; border-color: #c0202b; }
      .recon-aic-pill .dot {
        width: 7px; height: 7px; border-radius: 50%; background: #10b981;
        box-shadow: 0 0 0 0 rgba(16,185,129,.6); animation: recon-aic-pulse 2.4s infinite;
      }
      @keyframes recon-aic-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(16,185,129,.6); }
        70%  { box-shadow: 0 0 0 6px rgba(16,185,129,0); }
        100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
      }

      .recon-aic-panel {
        position: fixed; bottom: 1rem; right: 1rem; z-index: 9001;
        width: 380px; height: 500px; max-height: calc(100vh - 2rem);
        background: #fff; border: 1px solid #d0d0d0; border-radius: 6px;
        box-shadow: 0 14px 40px rgba(0,0,0,.18);
        display: flex; flex-direction: column;
        font-family: 'Inter', system-ui, sans-serif; overflow: hidden;
      }
      .recon-aic-head {
        padding: .65rem .85rem; border-bottom: 1px solid #e5e5e5;
        display: flex; align-items: center; justify-content: space-between;
        background: #1a1a1a; color: #fff;
      }
      .recon-aic-head .title { font-size: .85rem; font-weight: 600; display: flex; align-items: center; gap: .5rem; }
      .recon-aic-head .title .dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; }
      .recon-aic-head button { background: transparent; border: none; color: #ccc; cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 0 .25rem; }
      .recon-aic-head button:hover { color: #fff; }

      .recon-aic-msgs {
        flex: 1; overflow-y: auto; padding: .85rem;
        background: #fafafa;
        display: flex; flex-direction: column; gap: .65rem;
      }
      .recon-aic-msg {
        max-width: 88%; padding: .55rem .75rem; border-radius: 6px;
        font-size: .85rem; line-height: 1.4; word-wrap: break-word;
      }
      .recon-aic-msg.user {
        align-self: flex-end; background: #1a1a1a; color: #fff;
      }
      .recon-aic-msg.assistant {
        align-self: flex-start; background: #fff; color: #1a1a1a;
        border: 1px solid #e5e5e5;
      }
      .recon-aic-msg.assistant.error {
        background: #fef2f2; border-color: #fecaca; color: #991b1b;
      }
      .recon-aic-msg.thinking {
        align-self: flex-start; color: #999; font-style: italic; font-size: .8rem;
        background: transparent; border: none; padding: .25rem 0;
      }
      .recon-aic-thinking-dots { display: inline-flex; gap: 3px; align-items: center; margin-left: 2px; }
      .recon-aic-thinking-dots span { width: 5px; height: 5px; border-radius: 50%; background: #999; animation: recon-aic-bounce 1.4s ease-in-out infinite both; }
      .recon-aic-thinking-dots span:nth-child(1) { animation-delay: 0s; }
      .recon-aic-thinking-dots span:nth-child(2) { animation-delay: .2s; }
      .recon-aic-thinking-dots span:nth-child(3) { animation-delay: .4s; }
      @keyframes recon-aic-bounce {
        0%, 80%, 100% { opacity: .3; transform: scale(.8); }
        40% { opacity: 1; transform: scale(1); }
      }
      .recon-aic-chips {
        display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .45rem;
      }
      .recon-aic-chip {
        display: inline-flex; align-items: center; padding: .2rem .55rem;
        background: #f3f4f6; color: #1a1a1a; border: 1px solid #e0e0e0;
        border-radius: 999px; font-size: .72rem; font-weight: 500;
        text-decoration: none; transition: all .12s;
      }
      .recon-aic-chip:hover { background: #c0202b; color: #fff; border-color: #c0202b; }
      .recon-aic-chip .arrow { margin-left: .3rem; opacity: .55; }

      .recon-aic-input {
        border-top: 1px solid #e5e5e5; padding: .55rem .65rem;
        display: flex; gap: .4rem; background: #fff;
      }
      .recon-aic-input textarea {
        flex: 1; resize: none; border: 1px solid #d0d0d0; border-radius: 4px;
        padding: .45rem .55rem; font-size: .85rem; font-family: inherit;
        outline: none; max-height: 100px; min-height: 38px;
      }
      .recon-aic-input textarea:focus { border-color: #c0202b; box-shadow: 0 0 0 2px rgba(192,32,43,.12); }
      .recon-aic-input button {
        background: #c0202b; color: #fff; border: none; padding: 0 .85rem;
        border-radius: 4px; font-size: .85rem; font-weight: 600; cursor: pointer;
      }
      .recon-aic-input button:hover { background: #8a0e16; }
      .recon-aic-input button:disabled { background: #999; cursor: not-allowed; }
      .recon-aic-input .mic-btn {
        background: transparent; border: 1px solid #d0d0d0; border-radius: 4px;
        width: 32px; height: 32px; padding: 0; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; transition: all .15s;
      }
      .recon-aic-input .mic-btn:hover { background: #f5f5f5; border-color: #999; }
      .recon-aic-input .mic-btn.recording { background: #c0202b; border-color: #c0202b; animation: recon-aic-mic-pulse 1.2s ease-in-out infinite; }
      .recon-aic-input .mic-btn.recording svg { fill: #fff; }
      .recon-aic-input .mic-btn svg { width: 16px; height: 16px; fill: #555; }
      @keyframes recon-aic-mic-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(192,32,43,.4); }
        50% { box-shadow: 0 0 0 6px rgba(192,32,43,0); }
      }
      .recon-aic-mic-tip { font-size: .7rem; color: #c0202b; padding: .2rem .5rem; display: none; }
      .recon-aic-mic-tip.visible { display: block; }

      .recon-aic-empty {
        text-align: center; color: #999; font-size: .8rem; padding: 2rem 1rem;
      }
      .recon-aic-empty .examples {
        margin-top: 1rem; display: flex; flex-direction: column; gap: .35rem; align-items: center;
      }
      .recon-aic-empty .examples button {
        background: #fff; border: 1px solid #e5e5e5; color: #555; cursor: pointer;
        padding: .35rem .75rem; border-radius: 4px; font-size: .76rem;
        font-family: inherit;
      }
      .recon-aic-empty .examples button:hover { color: #c0202b; border-color: #c0202b; }

      .recon-aic-confirm {
        margin-top: .5rem; padding: .65rem .75rem;
        background: #fffaf0; border: 1px dashed #c0202b; border-radius: 4px;
      }
      .recon-aic-confirm .summary {
        margin: 0 0 .5rem 0; padding: 0; list-style: none;
        font-size: .8rem; line-height: 1.5; color: #1a1a1a;
      }
      .recon-aic-confirm .summary li { padding: .1rem 0; }
      .recon-aic-confirm .summary li strong { color: #555; font-weight: 600; margin-right: .35rem; }
      .recon-aic-confirm .actions {
        display: flex; gap: .4rem; align-items: center;
        margin-top: .5rem; padding-top: .5rem;
        border-top: 1px dotted #e0c0a8;
      }
      .recon-aic-confirm .actions button {
        padding: .35rem .85rem; border-radius: 3px; font-size: .78rem;
        font-weight: 600; cursor: pointer; border: none; font-family: inherit;
        transition: all .12s;
      }
      .recon-aic-confirm .actions .confirm {
        background: #c0202b; color: #fff;
      }
      .recon-aic-confirm .actions .confirm:hover { background: #8a0e16; }
      .recon-aic-confirm .actions .cancel {
        background: transparent; color: #666; border: 1px solid #d0d0d0;
      }
      .recon-aic-confirm .actions .cancel:hover { background: #f5f5f5; color: #1a1a1a; }
      .recon-aic-confirm .actions button:disabled {
        opacity: .5; cursor: not-allowed;
      }
      .recon-aic-confirm .countdown {
        margin-left: auto; font-size: .68rem; color: #999;
        font-family: ui-monospace, monospace;
      }
      .recon-aic-confirm .countdown.urgent { color: #c0202b; }
      .recon-aic-confirm.locked {
        background: #f5f5f5; border-style: solid; border-color: #d0d0d0;
        opacity: .7;
      }
      .recon-aic-confirm.locked .actions { display: none; }
      .recon-aic-confirm .resolved-tag {
        font-size: .68rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
        margin-top: .25rem;
      }
      .recon-aic-confirm .resolved-tag.confirmed { color: #065f46; }
      .recon-aic-confirm .resolved-tag.cancelled { color: #999; }
      .recon-aic-confirm .resolved-tag.expired   { color: #92400e; }
      .recon-aic-confirm .warnings {
        margin: .35rem 0 .15rem; padding: .4rem .55rem;
        background: #fef2f2; border-left: 3px solid #c0202b; border-radius: 2px;
        font-size: .76rem; color: #991b1b; line-height: 1.4;
      }
      .recon-aic-confirm .warnings ul { margin: 0; padding: 0; list-style: none; }
      .recon-aic-confirm .warnings li { padding: .1rem 0; }
      .recon-aic-confirm .warnings li::before { content: "⚠ "; margin-right: .25rem; }
      .recon-aic-confirm.has-warnings .actions .confirm {
        background: #92400e; /* darker amber to acknowledge the override */
      }
      .recon-aic-confirm.has-warnings .actions .confirm:hover { background: #78350f; }
    `;
    document.head.appendChild(style);
  }

  // ----- State -----
  const state = {
    open: false,
    sending: false,
    history: [],   // { role: 'user' | 'assistant', content: string, chips?: [] }
    disabled: false, // set true if /ai/chat returns 404
  };

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) state.history = JSON.parse(raw).slice(-MAX_HISTORY);
    } catch (_) { /* ignore */ }
  }
  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.history.slice(-MAX_HISTORY)));
    } catch (_) { /* ignore */ }
  }
  function clearHistory() {
    state.history = [];
    saveHistory();
    render();
  }

  loadHistory();

  // Speech Recognition setup
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var micBtn = document.getElementById('recon-aic-mic');
  var micTip = document.createElement('div');
  micTip.className = 'recon-aic-mic-tip';
  micTip.id = 'recon-aic-mic-tip';
  var micDenied = false;

  if (!SR && micBtn) { micBtn.style.display = 'none'; }
  if (SR && micBtn) {
    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    var isRecording = false;
    micBtn.addEventListener('click', function() {
      if (micDenied) return;
      if (isRecording) {
        recognition.stop();
        isRecording = false;
        micBtn.classList.remove('recording');
        return;
      }
      try {
        recognition.start();
        isRecording = true;
        micBtn.classList.add('recording');
      } catch(e) {
        micDenied = true;
        micBtn.style.display = 'none';
      }
    });
    recognition.onresult = function(event) {
      var input = document.getElementById('recon-aic-input');
      if (!input) return;
      var transcript = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      input.value = transcript;
      input.dispatchEvent(new Event('input'));
    };
    recognition.onerror = function(event) {
      isRecording = false;
      micBtn.classList.remove('recording');
      if (event.error === 'not-allowed') {
        micDenied = true;
        micBtn.style.display = 'none';
      }
    };
    recognition.onend = function() {
      isRecording = false;
      micBtn.classList.remove('recording');
    };
  }

  // ----- Render -----
  function render() {
    if (state.disabled) {
      root.innerHTML = '';
      return;
    }
    if (!state.open) {
      root.innerHTML = `
        <div class="recon-aic-pill" data-action="open">
          <span class="dot"></span>
          <span>Ask anything…</span>
        </div>
      `;
      return;
    }
    const empty = state.history.length === 0;
    root.innerHTML = `
      <div class="recon-aic-panel">
        <div class="recon-aic-head">
          <div class="title"><span class="dot"></span> Recon assistant</div>
          <div>
            <button data-action="clear" title="New conversation">↺</button>
            <button data-action="close" title="Close">×</button>
          </div>
        </div>
        <div class="recon-aic-msgs" id="recon-aic-msgs">
          ${empty ? renderEmpty() : state.history.map(renderMsg).join('')}
          ${state.sending ? '<div class="recon-aic-msg thinking">Recon assistant is thinking<div class="recon-aic-thinking-dots"><span></span><span></span><span></span></div></div>' : ''}
        </div>
        <form class="recon-aic-input" data-action="send">
          <button type="button" class="mic-btn" data-action="mic" id="recon-aic-mic" title="Voice input">
            <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93V21h2v-2.07A8 8 0 0 0 20 11h-2z"/></svg>
          </button>
          <textarea id="recon-aic-input"
                    placeholder="${empty ? 'Try: how many overdue invoices?' : 'Ask a follow-up…'}"
                    rows="1"
                    ${state.sending ? 'disabled' : ''}></textarea>
          <button type="submit" ${state.sending ? 'disabled' : ''}>Send</button>
        </form>
      </div>
    `;
    // Scroll messages to bottom.
    const msgs = document.getElementById('recon-aic-msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    // Focus input.
    const input = document.getElementById('recon-aic-input');
    if (input && !state.sending) input.focus();
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderMsg(m) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const errClass = m.error ? ' error' : '';
    const text = escapeHTML(m.content || '').replace(/\n/g, '<br>');
    const chips = (m.chips && m.chips.length)
      ? `<div class="recon-aic-chips">${m.chips.map(c => `
          <a class="recon-aic-chip" href="${escapeHTML(c.href)}">${escapeHTML(c.label)}<span class="arrow">→</span></a>
        `).join('')}</div>`
      : '';
    const confirm = m.confirm ? renderConfirmCard(m.confirm, m.confirmState) : '';
    return `<div class="recon-aic-msg ${role}${errClass}">${text}${confirm}${chips}</div>`;
  }

  function renderConfirmCard(confirm, confirmState) {
    if (!confirm) return '';
    const lines = (confirm.summary_lines || []).map(line => {
      // If line has "Label: value" shape, bold the label.
      const m = String(line).match(/^([^:]+):\s*(.*)$/);
      if (m) return `<li><strong>${escapeHTML(m[1])}:</strong>${escapeHTML(m[2])}</li>`;
      return `<li>${escapeHTML(line)}</li>`;
    }).join('');
    const cid = confirm.confirmation_id;
    const state = (confirmState && confirmState.status) || 'pending';
    const inflight = confirmState && confirmState.inflight;
    const lockedClass = state !== 'pending' ? ' locked' : '';
    const warnings = Array.isArray(confirm.warnings) ? confirm.warnings : [];
    const hasWarningsClass = warnings.length > 0 ? ' has-warnings' : '';
    let resolved = '';
    if (state === 'confirmed') resolved = '<div class="resolved-tag confirmed">✓ Confirmed</div>';
    else if (state === 'cancelled') resolved = '<div class="resolved-tag cancelled">○ Cancelled</div>';
    else if (state === 'expired')   resolved = '<div class="resolved-tag expired">⏱ Expired</div>';

    const warningsBlock = warnings.length > 0
      ? `<div class="warnings"><ul>${warnings.map(w =>
          // Strip any leading "⚠ " from server text so we don't double-render it
          `<li>${escapeHTML(String(w).replace(/^\s*[⚠!]\s*/, ''))}</li>`
        ).join('')}</ul></div>`
      : '';

    const expiresAt = confirm.expires_at_ms || 0;
    const confirmLabel = warnings.length > 0 ? 'Confirm anyway' : 'Confirm';
    return `
      <div class="recon-aic-confirm${lockedClass}${hasWarningsClass}" data-cid="${cid}" data-expires-at="${expiresAt}">
        <ul class="summary">${lines}</ul>
        ${warningsBlock}
        ${resolved}
        ${state === 'pending' ? `
          <div class="actions">
            <button class="confirm" data-action="ai-confirm" data-cid="${cid}" ${inflight ? 'disabled' : ''}>${confirmLabel}</button>
            <button class="cancel" data-action="ai-cancel" data-cid="${cid}" ${inflight ? 'disabled' : ''}>Cancel</button>
            <span class="countdown" data-cid="${cid}">…</span>
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderEmpty() {
    const examples = [
      'how many overdue invoices?',
      "what's on today's schedule?",
      'find Cambridge Towers estimates',
      'how much does TechSquare owe?',
    ];
    return `
      <div class="recon-aic-empty">
        <div>Ask about jobs, customers, schedule, invoices, bills, or anything in Recon.</div>
        <div class="examples">
          ${examples.map(q => `<button data-action="example" data-q="${escapeHTML(q)}">${escapeHTML(q)}</button>`).join('')}
        </div>
      </div>
    `;
  }

  // ----- Actions -----
  async function send(text) {
    text = (text || '').trim();
    if (!text || state.sending) return;

    state.history.push({ role: 'user', content: text });
    state.sending = true;
    saveHistory();
    render();

    try {
      const res = await fetch('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: state.history.slice(-MAX_HISTORY),
        }),
      });
      if (res.status === 404) {
        // Kill switch — hide the widget for the rest of the session.
        state.disabled = true;
        sessionStorage.setItem('recon_ai_chat_disabled', '1');
        render();
        return;
      }
      if (!res.ok) {
        const errBody = await safeJSON(res);
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const msg = {
        role: 'assistant',
        content: data.reply || '(no reply)',
        chips: data.chips || [],
      };
      if (data.confirm && data.confirm.confirmation_id) {
        // Server returned a proposed mutation — attach to message.
        const expiresMs = (data.confirm.expires_in_seconds || 300) * 1000;
        msg.confirm = {
          ...data.confirm,
          expires_at_ms: Date.now() + expiresMs,
        };
        msg.confirmState = { status: 'pending', inflight: false };
      }
      state.history.push(msg);
    } catch (err) {
      state.history.push({
        role: 'assistant',
        content: 'Sorry — ' + (err && err.message ? err.message : 'something went wrong.'),
        error: true,
      });
    } finally {
      state.sending = false;
      saveHistory();
      render();
    }
  }
  async function safeJSON(res) {
    try { return await res.json(); } catch (_) { return {}; }
  }

  // Find the message in history that owns a confirmation_id.
  function findMessageByCid(cid) {
    for (let i = state.history.length - 1; i >= 0; i--) {
      const m = state.history[i];
      if (m.confirm && String(m.confirm.confirmation_id) === String(cid)) return m;
    }
    return null;
  }

  async function resolveConfirmation(cid, accept) {
    const msg = findMessageByCid(cid);
    if (!msg || !msg.confirmState || msg.confirmState.status !== 'pending') return;
    msg.confirmState.inflight = true;
    saveHistory();
    render();

    try {
      const res = await fetch('/ai/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ confirmation_id: cid, accept }),
      });
      if (!res.ok) {
        const errBody = await safeJSON(res);
        // 409 = already resolved/expired on server. Reflect that.
        if (res.status === 409) {
          msg.confirmState = { status: errBody.status || 'expired', inflight: false };
          saveHistory();
          render();
          return;
        }
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.cancelled) {
        msg.confirmState = { status: 'cancelled', inflight: false };
      } else if (data.ok) {
        msg.confirmState = { status: 'confirmed', inflight: false };
        // Append a follow-up assistant message confirming what landed.
        state.history.push({
          role: 'assistant',
          content: data.result_summary || (accept ? 'Done.' : 'Cancelled.'),
          chips: data.chips || [],
        });
      } else {
        throw new Error('Unexpected response.');
      }
    } catch (err) {
      msg.confirmState = { status: 'pending', inflight: false };
      state.history.push({
        role: 'assistant',
        content: 'Sorry — couldn\'t complete that: ' + (err && err.message ? err.message : 'something went wrong.'),
        error: true,
      });
    } finally {
      saveHistory();
      render();
    }
  }

  // ----- Event delegation -----
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'open')  { state.open = true; render(); }
    if (action === 'close') { state.open = false; render(); }
    if (action === 'clear') { clearHistory(); }
    if (action === 'example') {
      e.preventDefault();
      send(target.dataset.q);
    }
    if (action === 'ai-confirm') {
      e.preventDefault();
      resolveConfirmation(target.dataset.cid, true);
    }
    if (action === 'ai-cancel') {
      e.preventDefault();
      resolveConfirmation(target.dataset.cid, false);
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-action="send"]');
    if (!form) return;
    e.preventDefault();
    const ta = document.getElementById('recon-aic-input');
    if (!ta) return;
    const text = ta.value;
    ta.value = '';
    send(text);
  });

  // Submit on Enter (Shift+Enter = newline).
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'recon-aic-input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = e.target.closest('form');
      if (form) form.requestSubmit();
    }
  });

  // Honor previous session's disabled state.
  if (sessionStorage.getItem('recon_ai_chat_disabled') === '1') {
    state.disabled = true;
  }

  // ----- Countdown ticker for pending confirmation cards -----
  // Updates every second; flips state to 'expired' client-side when expires_at_ms passes.
  function tickConfirmCountdowns() {
    const cards = document.querySelectorAll('.recon-aic-confirm[data-expires-at]');
    let needsRerender = false;
    cards.forEach(card => {
      const cid = card.dataset.cid;
      const expiresAt = parseInt(card.dataset.expiresAt, 10);
      if (!expiresAt) return;
      const remaining = expiresAt - Date.now();
      const cdEl = card.querySelector('.countdown[data-cid="' + cid + '"]');
      if (remaining <= 0) {
        // Mark expired locally; next render will lock the card.
        const msg = findMessageByCid(cid);
        if (msg && msg.confirmState && msg.confirmState.status === 'pending') {
          msg.confirmState = { status: 'expired', inflight: false };
          needsRerender = true;
        }
        return;
      }
      if (cdEl) {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        cdEl.textContent = mins + ':' + String(secs).padStart(2, '0') + ' left';
        if (remaining < 60000) cdEl.classList.add('urgent');
        else cdEl.classList.remove('urgent');
      }
    });
    if (needsRerender) {
      saveHistory();
      render();
    }
  }
  setInterval(tickConfirmCountdowns, 1000);

  // Initial render.
  render();
})();
