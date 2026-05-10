# Round 11 — Global AI Assistant Scope

Authored: 2026-05-10 (Claude session, while Hermes seeds Round 12 mock data)
Status: **Spec only — not yet kicked off to Hermes.** This file is the source-of-truth scope so when Round 12 verifies clean we can hand a clear directive over the bridge.

---

## 1. What Michael asked for

> "I would say just have a AI chat box on the home page... it should know the system, resolve fuzzy names, detect schedule conflicts, execute tool-calls, navigate, search."

Translation: a single always-on chat input that lives on the dashboard and can answer questions about the data, resolve approximate references ("Smith job"), warn about scheduling problems, take actions on the user's behalf (with confirmation), and navigate the user to relevant pages.

---

## 2. Capability tiers — ship in this order

### Tier 1 — Read & Search (ship first)
Pure read-only Q&A. Zero risk of data damage.
- "How many invoices are overdue?" → answers from DB
- "Where's the Cambridge Towers job?" → fuzzy-match, link out
- "What's on the schedule today?" → today's WO list
- "How much does the O'Brien job owe?" → invoice lookup
- "Show me last week's revenue" → accounting summary

### Tier 2 — Navigate (ship second)
Suggest a navigation, render the link inline, let user click.
- "Open the Smith estimate" → "I found 2 estimates for Smith. [EST-1042 — Smith Bathroom Remodel] [EST-1051 — Smith Roof Repair]"
- "Show me bills due this week" → renders link to `/bills?status=approved&due=this_week`

### Tier 3 — Suggest-then-execute (ship third)
Tool-call execution with explicit confirmation. Every mutation surfaces a "Confirm" button before it runs. Pattern matches the existing `suggest-then-approve` flow used in AI extraction.
- "Mark INV-1042 as paid" → "I'd run: mark INV-1042-0001 paid in full ($X,XXX). [Confirm] [Cancel]"
- "Create an estimate for the Smith roof job" → opens AI WO/estimate extractor flow
- "Schedule WO-1042 for tomorrow at 10am" → confirms slot, checks for conflicts, executes
- "Approve all draft bills under $500" → batch operation with confirmation list

### Tier 4 — Conflict detection (ship fourth)
Proactive warnings in chat replies, even without explicit ask.
- "Schedule WO-1043 for Mike on Thursday at 9am" → "Mike is already on WO-1041 Thursday 8-12. Reschedule? Reassign?"
- "Mark INV-1042 paid" → "INV-1042 has $200 remaining. Did you mean partial?"

---

## 3. Architecture sketch

### Client side
- Floating chat box widget in `src/views/layouts/header.ejs` (or as include) — visible on every page, collapsible.
- Default state: collapsed pill in bottom-right with placeholder "Ask anything…"
- Expanded: 380×500 panel with conversation history + input + send button.
- POST conversation to `/ai/chat` (new route), receive structured response.

### Server side
- New route file: `src/routes/ai-chat.js`
- New service: `src/services/ai-chat.js` — orchestrator that:
  1. Builds a compact system prompt with current user context (role, recent activity)
  2. Pulls RAG-style snapshot of relevant data (for read queries: counts, today's schedule, recent customers)
  3. Calls the LLM (DeepSeek default, same as `services/ai.js`)
  4. Parses tool-call JSON if present
  5. Either renders text reply OR queues a tool-call for user confirmation

### Tool definitions (initial set)
```js
const TOOLS = {
  search_customers:  { args: { query: string },                 reads: true  },
  search_estimates:  { args: { query?, status?, customer_id? }, reads: true  },
  search_invoices:   { args: { query?, status?, customer_id? }, reads: true  },
  search_work_orders:{ args: { query?, status?, date? },        reads: true  },
  search_bills:      { args: { query?, status?, vendor_id? },   reads: true  },
  get_schedule:      { args: { date_start, date_end },          reads: true  },
  navigate:          { args: { path: string },                  reads: true, hint: 'navigate' },
  mark_invoice_paid: { args: { invoice_id, amount, payment_date }, reads: false, confirm: true },
  send_estimate:     { args: { estimate_id },                   reads: false, confirm: true },
  approve_bill:      { args: { bill_id },                       reads: false, confirm: true },
  schedule_wo:       { args: { wo_id, date, time, assignee },   reads: false, confirm: true, conflict_check: true },
};
```

### Conflict-check helper
```js
checkScheduleConflict({ assignee_user_id, date, time, duration_hours = 4 })
  → returns [{wo_id, display_number, customer, time_overlap}]
```

---

## 4. UX patterns

- **Streaming**: optional Phase 2. Ship Phase 1 with full-response-then-render to keep it simple.
- **Confirmation buttons**: rendered inline as `<button data-confirm-tool="mark_invoice_paid" data-args="...">Confirm</button>` and intercepted by a small client script.
- **Reference disambiguation**: when fuzzy match returns >1 result, render all as buttons, let user pick. Don't proceed without disambiguation.
- **History**: conversation persists per session (cookie-based, in-memory or session-store). Clears on logout.
- **Audit log**: every tool call (suggested + confirmed + executed) writes an audit row with user_id, tool, args, outcome.

---

## 5. Privacy & safety

- Workers (role=worker) only see WOs assigned to them in chat replies (mirror existing route-level scoping).
- Chat **never** exposes raw cost data to workers (mirror canSeePrices).
- LLM input redacts `password_hash` and `email` from any snapshot it sends.
- Every mutation tool requires confirmation. **No silent writes.**
- Add a kill-switch env var: `AI_CHAT_ENABLED=0` disables the feature entirely.

---

## 6. Smoke tests (when Round 11 ships)

1. Ask "how many overdue invoices?" → returns correct count + link
2. Ask "where's the Smith job?" → fuzzy match, links out
3. Ask "what's the schedule today?" → renders today's WOs
4. Ask "open EST-1042" → returns navigation link, click works
5. Ask "mark INV-1042 paid" → returns confirmation card, click Confirm → status changes, JE posts
6. Ask "schedule WO-1043 for Mike Thursday 9am" with conflict → returns warning + alternatives
7. As worker role: ask "how much is invoice 1042?" → refuses (canSeePrices check)
8. AI_CHAT_ENABLED=0 → widget hidden, /ai/chat returns 404

---

## 7. Estimated effort

- Tier 1 (read): ~2 hours of Hermes time
- Tier 2 (navigate): ~30 min on top of Tier 1
- Tier 3 (suggest-then-execute): ~3 hours (confirmation UI + tool wiring + audit)
- Tier 4 (conflict detection): ~1.5 hours
- Polish + smoke tests: ~1 hour
- **Total: ~8 hours of focused Hermes work, batched into 2-3 messages.**

---

## 8. Open questions for Michael (when he's back)

1. Do we want streaming responses from day one, or is full-response OK for v1?
2. Should the chat history persist across sessions (DB-backed) or just in-memory per session?
3. Tier order confirmed? Read → Navigate → Execute → Conflict-detect.
4. Any specific tool-calls he wants prioritized? (e.g., "always include schedule_wo from day 1")

---
— Claude
