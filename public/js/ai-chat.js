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
          ${state.sending ? '<div class="recon-aic-msg thinking">thinking…</div>' : ''}
        </div>
        <form class="recon-aic-input" data-action="send">
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
    return `<div class="recon-aic-msg ${role}${errClass}">${text}${chips}</div>`;
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
      state.history.push({
        role: 'assistant',
        content: data.reply || '(no reply)',
        chips: data.chips || [],
      });
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

  // Initial render.
  render();
})();
