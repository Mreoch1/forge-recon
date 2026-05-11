# FORGE — Complete Product & System Analysis

> Authored: 2026-05-11 (Claude sub-agent codebase analysis)
> Sources: full read of schema files, services, routes, scope docs, DECISIONS.md, CHANGELOG.md

---

## 1. Core product purpose

FORGE (Field Operations, Records & General Estimating) is an internal-deployment construction work-order management system built for general contractors who run a small-to-mid-sized field crew. It collapses what a typical contractor stitches together from QuickBooks + a paper schedule + a text-thread dispatch flow + a "send the customer a PDF" workflow into a single web application. It walks a job from initial lead capture through estimate generation, customer acceptance, scheduled field work, invoicing, payment, vendor bills, and finally into a balanced double-entry ledger with real reports (trial balance, P&L, balance sheet). The differentiator is that it leads with the schedule and the day's operations, not with KPI dashboards or data tables — the home page answers "what is happening right now?" first and "what does it total to?" second.

**Primary user types:**
- **Admin** — owner/operator. Full access. Manages users at `/admin/users`, company settings at `/admin/settings`, sees AI usage at `/admin/ai-usage`, runs all financial reports, can post manual journal entries, can mutate any record.
- **Manager** — office staff / dispatcher / bookkeeper. Same operational permissions as admin minus the user-management and AI-usage admin pages. Schedules WOs, sends estimates, books invoices as paid, approves vendor bills, runs reports.
- **Worker** — field tech. Sees only `/work-orders` (filtered to assigned-only) and a worker-scoped dashboard. Cannot see prices, costs, line totals, or any financial table. Can add notes/photos, mark line items complete, transition WO status. AI chat is scoped to the same set — financial queries are politely refused.

**Main business workflows:**
- Lead capture: customer record → job record (status `lead`) → estimate.
- Estimating: WO created from job → estimate created 1:1 from WO → sent to customer → accepted.
- Dispatch: WO scheduled (date/time/end_time/assignee) → drag-rescheduled on calendar → worker marks status `in_progress` → marks line items complete → status `complete`.
- Billing: estimate accepted → user picks lines for invoice → invoice generated → sent → marked paid (full or partial).
- Vendor side: bill drafted → approved → paid; AI extracts vendor invoices from PDFs into the same flow.
- Accounting: every operational event auto-posts a balanced JE; reports aggregate from the journal lines.

---

## 2. Entity architecture

Tables grouped by domain. Schema lives in three files: `src/db/schema.sql` (core), `src/db/schema-accounting.sql` (ledger), `src/db/schema-postgres.sql` (deploy target — adds `pending_confirmations`, `JSONB` audit, `metadata` column, `mock` flags, `idx_invoices_due_date`, auto-update trigger for `updated_at`).

**Identity:**
- `users` — admin/manager/worker accounts. PK referenced by `jobs.assigned_to_user_id`, `work_orders.assigned_to_user_id`, audit log, JE creator.

**CRM:**
- `customers` — name, email, billing_email (separate for invoices), phone, address. 1:N → `jobs`.
- `vendors` — vendor master with default_expense_account_id → `accounts`. 1:N → `bills`.

**Operations:**
- `jobs` — customer_id FK, scheduled_date/time, assigned_to_user_id, status (`lead|estimating|scheduled|in_progress|complete|cancelled`). 1:N → `work_orders`.
- `work_orders` — root document. job_id FK, parent_wo_id self-FK (sub-WOs), wo_number_main + wo_number_sub → `display_number` `"0001-0000"`. Status (`scheduled|in_progress|complete|cancelled`). scheduled_date, scheduled_time, **scheduled_end_time** (added via boot migration in `server.js`), completed_date, assigned_to_user_id + assigned_to (free-text fallback). 1:1 → `estimates`; 1:N → `wo_notes`, `wo_photos`, `work_order_line_items`.
- `work_order_line_items` — description, quantity, unit, unit_price, cost, line_total, completed flag, completed_at. CASCADE on WO delete.
- `wo_notes` — work_order_id, user_id, body. Append-only.
- `wo_photos` — work_order_id, user_id, filename, caption.
- `items_library` — reusable line-item catalog. Planned AI auto-maintenance per DECISIONS.md.

**Financials (customer-facing):**
- `estimates` — work_order_id UNIQUE (1:1). Status (`draft|sent|accepted|rejected|expired`). subtotal, tax_rate, tax_amount, total, cost_total, valid_until, sent_at, accepted_at.
- `estimate_line_items` — `selected` flag carries through to invoice generation.
- `invoices` — estimate_id UNIQUE (1:1), work_order_id denormalized. Status (`draft|sent|paid|overdue|void`). payment_terms enum, due_date, amount_paid.
- `invoice_line_items` — copied from selected estimate lines.

**Vendor financials:**
- `bills` — vendor_id, optional job_id/work_order_id, status (`draft|approved|paid|void`), bill_date, due_date, source (`manual|ai`), approved_by_user_id.
- `bill_lines` — account_id FK (selects expense account per line), description, quantity, unit_price, line_total.

**Accounting:**
- `accounts` — chart of accounts. code unique (1000=Cash, 1100=AR, 2000=AP, 2100=Sales Tax Payable, 4000=Service Revenue, 5900=Misc Expense, 5950=Sales Tax — Vendor Bills). type CHECK in `asset|liability|equity|revenue|expense`. parent_account_id self-FK for hierarchy.
- `journal_entries` — entry_date, description, source_type (`invoice|payment|bill|bill_payment|manual|invoice_void`), source_id, created_by_user_id, reversed_by_entry_id.
- `journal_lines` — journal_entry_id, account_id, debit, credit, description. Each JE balances debits == credits.

**AI/Audit:**
- `ai_extractions` — vendor-invoice extractor queue. source_filename, extracted_json (JSONB in PG), vendor_match_id, suggested_account_id, confidence, status (`pending|approved|rejected|superseded`), resulting_bill_id.
- `pending_confirmations` — suggest-then-confirm mutation queue. user_id, tool, args (JSON), summary, warnings, expires_at (5-min TTL), status.
- `audit_logs` — every financial mutation. entity_type, entity_id, action, before_json/after_json (JSONB in PG), source CHECK in `user|ai|stripe|plaid|system`, user_id, reason. PG version adds `metadata` JSONB.

**Settings:**
- `company_settings` — singleton (id=1), company_name, address, EIN, default_tax_rate, default_payment_terms, next_wo_main_number counter, logo_path, current_year.

**Relational graph:**
```
Customer ──< Job ──< WorkOrder ─1:1─ Estimate ─1:1─ Invoice
                       │
                       ├── work_order_line_items
                       ├── wo_notes
                       ├── wo_photos
                       └── parent_wo_id (sub-WOs)

Vendor ──< Bill ──< bill_lines ──> Account

Account ──< journal_lines >── JournalEntry
                                  │
                                  └─ source_type + source_id → Invoice | Payment | Bill | BillPayment

User → audit_logs (entity_type + entity_id polymorphic)
User → pending_confirmations (tool + args, 5-min TTL)
```

---

## 3. Workflow mapping

Full lifecycle from lead to financial report:

1. **Customer created** — `POST /customers` (manual) or AI chat `create_customer` (suggest-then-confirm via `pending_confirmations`). Round 23 (scoped) will pre-populate from a Brave Search API lookup.
2. **Job created** — `POST /jobs` with customer_id, title, address. Status `lead → estimating → scheduled → in_progress → complete | cancelled`.
3. **WO created from Job** — `POST /work-orders?job_id=X`. `numbering.js` generates `wo_number_main` via atomic transaction. `display_number` = `"MMMM-0000"`. Sub-WOs inherit main number with incrementing sub.
4. **WO scheduled** — set scheduled_date, scheduled_time, scheduled_end_time, assigned_to_user_id (or free-text assigned_to). Driven by edit form, AI `schedule_wo` tool, or drag-to-reschedule on the calendar.
5. **Estimate created from WO** — `POST /estimates?work_order_id=X`. Status `draft`. Line items added; subtotal/tax/total calculated server-side. Status: `draft → sent → accepted | rejected | expired`.
6. **Estimate accepted → invoice generated** — `POST /estimates/:id/generate-invoice` redirects to `GET /estimates/:id/select-for-invoice` (line-selection page). User picks which lines, then POST creates invoice with payment_terms + due_date.
7. **Invoice lifecycle** — `draft → sent` (`POST /invoices/:id/send` generates PDF, writes `.eml`, triggers `postInvoiceSent` JE) → `paid` on full / `overdue` auto-displayed when past due / `void` on reversal.
8. **Payment received → JE auto-posted** — `POST /invoices/:id/mark-paid`. `postPaymentReceived` posts `DR Cash / CR AR`.
9. **Bill received** — `POST /bills` (manual) or extracted from PDF into `ai_extractions`. Status `draft → approved` (`postBillApproved`: DR each expense account + DR Sales Tax 5950 / CR AP) → `paid` (`postBillPaid`: DR AP / CR Cash) / `void`.
10. **Trial balance / P&L / Balance sheet** — query views at `/accounting/reports/*`. All aggregate from `journal_lines × accounts`. Reports always balance.

**Timeline events** surface on the dashboard via `services/timeline.js::buildDayTimeline()`. Merges per-WO chronology from four sources for the current day: WO status transitions (audit_logs), `wo_notes` rows, line-item completions (grouped within 5-min buckets), linked estimate/invoice events.

---

## 4. Feature inventory

✅ shipped · 🚧 partial · 📋 scoped

**Operations**
- ✅ Work orders CRUD with sub-WO hierarchy
- ✅ WO line items with completed checkbox + completed_at timestamp
- ✅ WO notes (append-only timeline)
- ✅ WO photos (table + upload UI)
- ✅ Status flow with audit_logs writes
- ✅ AI-assisted WO creation from free text
- ✅ WO PDF generation (no pricing — internal-only doc)

**Scheduling**
- ✅ Week, 2-week, month views
- ✅ Hour gutter 6 AM – 8 PM, day columns, hour-row anchor lines
- ✅ Multi-assignee color palette
- ✅ Today-column tint, "now" line
- ✅ scheduled_end_time persisted on WO
- ✅ Drag-to-reschedule with confirm-before-write
- ✅ Month view: day-cell drops open from-to popup; ≤3 pills per cell + "+N more"
- ✅ Hover card on schedule blocks
- ✅ Conflict detection (`services/scheduling.js::findScheduleConflicts`)
- 📋 Unscheduled lane / inbox of un-dated WOs (Round 20h)
- 📋 Holidays/closures shading (Round 20j)
- 📋 Status-based colors (Round 20g — Blue scheduled / Orange in_progress / Green complete / Red urgent / Grey unassigned)

**CRM**
- ✅ Customers CRUD + search/pagination
- ✅ Vendors CRUD with default expense account
- 📋 Web-augmented entity lookup (Round 23 — Brave Search API)
- 📋 Customer workspace (jobs/estimates/invoices/activity all on one show page)

**Estimates**
- ✅ CRUD + line items (cost column internal-only)
- ✅ PDF generation via pdfkit
- ✅ Send (writes .eml in dev; Resend SMTP on deploy)
- ✅ Status flow draft → sent → accepted/rejected/expired
- ✅ `selected` flag on lines → carries to invoice
- ✅ Profit/ROI strip on show page (admin/manager only)
- ✅ Margin % column on index

**Work-order completion**
- ✅ Per-line completed checkboxes (worker UI)
- ✅ Line-completion events bubble to timeline
- ✅ Progress bar inline on WO show

**Invoicing**
- ✅ Generate from accepted estimate via select-for-invoice page
- ✅ PDF with company header, line items, totals, balance-due
- ✅ Send via .eml multipart attachment
- ✅ payment_terms enum + due_date computation
- ✅ Mark paid (partial + full), auto-overdue display, void
- ✅ JE auto-posted on send/payment

**Payments**
- ✅ Inline mark-paid form on invoice show
- ✅ Auto-JE `DR Cash / CR AR` for full or partial
- ✅ Sales tax handled (CR Sales Tax Payable 2100 on send)
- 📋 Stripe integration (scoped, not wired)
- 📋 Plaid bank-balance sync (scoped, not wired)

**Accounting**
- ✅ Chart of accounts seeded with 24 starter accounts + 5950 Sales Tax — Vendor Bills
- ✅ Journal entries + journal_lines, double-entry validated
- ✅ Trial balance, P&L, balance sheet
- ✅ Auto-JE on invoice send, payment received, invoice void, bill approved, bill paid
- 📋 Manual journal entry UI (Round 21 priority #1)
- 📋 AR aging, AP aging reports (Round 21 priorities #2-3)
- 📋 Bank reconciliation, statement of cash flows (Round 21 priorities #4-5)

**Vendor management**
- ✅ Vendors CRUD with default_expense_account_id
- ✅ Bills CRUD with status flow
- ✅ Per-line account selection

**Reporting**
- ✅ Trial balance with balanced check
- ✅ P&L
- ✅ Balance sheet
- ✅ Admin AI usage page (calls, tokens, cost, 14-day sparkline, top users)

**AI functionality**
- ✅ Provider-agnostic wrapper (DeepSeek default)
- ✅ Chat widget (floating bottom-right pill)
- ✅ Tier 1 read tools (search_customers/estimates/invoices/work_orders/bills, get_schedule, get_dashboard_summary)
- ✅ Tier 2 navigate tool with path guard
- ✅ Tier 3 mutation tools (create_customer, send_estimate, mark_invoice_paid, approve_bill, add_wo_note, schedule_wo, reschedule_wo, assign_wo)
- ✅ Keyword-based mutation intent detection
- ✅ Conflict detection inline
- ✅ Disambiguation chips on ambiguous name matches
- ✅ 5-min expiry + ownership check on confirmations
- 🚧 Vendor bill extraction (table + scope; extractor partly wired)
- 📋 Items-library auto-maintenance (Round 9 stalled)
- 📋 Web-augmented customer creation (Round 23)

**User roles/permissions**
- ✅ admin/manager/worker triple enforced in middleware
- ✅ Worker scope on AI chat (financial tools refused, schedule filtered)

**Audit log**
- ✅ Written on every status transition, financial mutation, AI chat call

**File system**
- 📋 Folders + files tables + entity workspaces (Round 24 scoped)
- 📋 Supabase Storage migration on deploy

---

## 5. Role system

Enforced at `src/middleware/auth.js` + route-mount level in `src/server.js`.

**Admin** — All routes. Mounts behind `requireAdmin`: `/admin/users`, `/admin/settings`, `/admin/ai-usage`. Can rotate any user's password, deactivate users, edit company singleton. Self-delete refused; last-active-admin protection. Manual JE entry (Round 21).

**Manager** — Mounts behind `requireManager` (admin OR manager): `/customers`, `/jobs`, `/estimates`, `/invoices`, `/bills`, `/vendors`, `/accounting`. Cannot reach admin pages. Full operational write authority: schedule, send, approve, mark paid, void.

**Worker** — Mounts behind `requireAuth` only: `/work-orders`, `/schedule`, `/ai/*`. `loadCurrentUser` sets `res.locals.canSeePrices = false` — every view that shows cost/price/profit/ROI guards on this. AI chat: `WORKER_ALLOWED` whitelist (search_work_orders, get_schedule, navigate, search_customers). Other tools refused with polite reply. `filterForWorker()` post-strips money fields recursively. Schedule/WO queries auto-add `AND (assigned_to_user_id = ? OR assigned_to LIKE %name%)`.

---

## 6. Scheduling system

**Calendar architecture** (`src/routes/schedule.js` + `src/views/schedule/{week,2week,month}.ejs`):
- Three views off a single route `GET /schedule?view=…&date=…&assignee=…`
- Hour gutter 6 AM – 8 PM (`HOURS_START=6, HOURS_END=20, TOTAL_MINUTES=840`)
- Week: 7-column grid + hour gutter with anchor lines
- 2-week: 14 columns same layout (stacked two 7-column rows)
- Month: 6×7 standard grid, ≤3 pills per cell + "+N more" link
- WO blocks positioned by `scheduled_time → top: %`, height by `(end_time − start_time)/840 × 100%`
- "Now" line: 1px red across all columns
- Today column subtly tinted

**Assignment model:**
- `work_orders.assigned_to_user_id` — FK to `users` (preferred — enables conflict detection)
- `work_orders.assigned_to` — free-text fallback for subcontractors / unlisted labor

**Conflict prevention** (`services/scheduling.js::findScheduleConflicts`):
- Takes `{assignee_user_id, date, time, end_time | duration_hours, exclude_wo_id}`
- Returns 0 if no `assignee_user_id` (free-text labor not conflict-checked)
- Queries all `scheduled|in_progress` WOs on that date for the same assignee
- Computes overlap minutes via `min(proposedEnd, existingEnd) − max(proposedStart, existingStart)`
- Returns `[{wo_id, display_number, customer_name, scheduled_time, end_time, duration_hours, overlap_minutes}]`
- Called from AI mutation tools → conflicts become `warnings[]` on the confirmation card

**Dispatch workflow:**
- Drag-to-reschedule client (`public/js/schedule-drag.js`) uses pointer events for mouse+touch
- Each WO block carries `data-wo-id`, `data-current-date`, `data-current-time`, `data-end-time`
- On drop, a from-to popup appears with editable start/end inputs
- Month-view day-cell drops open the popup with a default 4-hour duration
- Hover card on month pills shows WO#, customer, job, assignee, status badge

**Unscheduled lane** — scoped (Round 20h) but not built. Will surface WOs with `scheduled_date IS NULL` as drag-source pills in a left rail.

---

## 7. Accounting architecture

**Ledger structure:**
- `accounts.type` constrained to `asset|liability|equity|revenue|expense`
- `parent_account_id` self-FK for hierarchy
- Seeded chart in `src/db/init-accounting.js`: 1000 Cash, 1100 AR, 2000 AP, 2100 Sales Tax Payable, 3000 Owners Equity, 4000 Service Revenue, 5xxx expenses, 5900 Misc Expense (fallback), 5950 Sales Tax — Vendor Bills.

**Double-entry posting** (`src/services/accounting-posting.js`):
- `postJournalEntry()` validates `abs(totalDr − totalCr) ≤ 0.005` before INSERT; throws on imbalance
- Wraps INSERT journal_entries + journal_lines in `db.transaction()`
- Writes a paired `audit_logs` row with `source='system'`

**Auto-JE triggers:**
- Invoice draft → sent: `postInvoiceSent` → `DR AR total / CR Service Revenue subtotal / CR Sales Tax Payable tax_amount`
- Payment received: `postPaymentReceived` → `DR Cash / CR AR` (partial OK)
- Invoice void: `postInvoiceVoid` → mirrored reversal, links via `journal_entries.reversed_by_entry_id`
- Bill draft → approved: `postBillApproved` → for each line `DR <line.account_id or 5900>` line_total, then `DR 5950 Sales Tax tax_amount` (if > 0), then `CR AP total`
- Bill paid: `postBillPaid` → `DR AP / CR Cash`
- All postings idempotent: probe `journal_entries WHERE source_type=? AND source_id=?` before inserting

**Audit log** (`src/services/audit.js`):
- entity_type, entity_id, action, before_json/after_json, source enum, user_id, reason

**Reports** (`src/views/accounting/reports/`):
- **Trial balance**: sum debits − credits per account, split into Dr/Cr columns, balanced-check at footer
- **P&L**: revenue + expense types only, revenue − expense = net income
- **Balance sheet**: assets debit-normal, liabilities + equity credit-normal, balance check

---

## 8. AI integration points

**Current AI services:**
- `src/services/ai.js` — provider-agnostic wrapper. DeepSeek default. Returns `{ok, text, tokens, latency_ms}`.
- `src/services/ai-chat.js` — orchestrator. System prompt + tool descriptions + role context. 2-round LLM flow (decide → execute → summarize). Audits every chat call.
- `src/services/ai-tools.js` — tool registry. Read: search_customers/estimates/invoices/work_orders/bills, get_schedule, get_dashboard_summary, navigate. Mutate: create_customer, send_estimate, mark_invoice_paid, approve_bill, add_wo_note, schedule_wo, reschedule_wo, assign_wo. Each mutation has both `propose()` and `execute()`.
- Keyword-based mutation intent detection runs before LLM call — more reliable than LLM for action verbs.
- Vendor bill extraction queue (`ai_extractions` table; extractor partly wired).

**Planned:**
- Round 23 — web-augmented customer creation. Brave Search API. Top 3 candidates with phone/address/website/source → user picks → server uses selected candidate.
- Round 9 stalled — items-library auto-maintenance.

**Human approval checkpoints:**
- Every mutation: `propose()` validates → `pending_confirmations` row with `expires_at = now + 5min` → client renders confirm card → user clicks → `POST /ai/chat/confirm` → ownership + non-expired + still `pending` checks → `MUTATION_TOOLS[tool].execute()` → flips to `confirmed` → returns result with href.
- DECISIONS.md rule: "AI Suggests → User Reviews → User Approves → System Posts."

**Worker scope:**
- `WORKER_ALLOWED = ['search_work_orders','get_schedule','navigate','search_customers']`
- `add_wo_note` is the only mutation a worker can propose, and only on assigned WOs
- `filterForWorker()` post-strips money fields
- Schedule/WO queries auto-add assigned-to filter

---

## 9. UI/UX structure

**Navigation:**
- Dashboard / Schedule / Jobs / Customers / Estimates / Work Orders / Invoices / More ▾
- More dropdown: Vendors / Bills / Accounting / Admin (admin-only)

**Dashboard structure** (`src/views/dashboard/v2.ejs`):
- Asymmetric grid (1.65fr left / 1fr right)
- Left dominant: today's date as h1, then today's WO timeline as vertical list. Each WO row = WO# + customer (bold) + job description (muted) + assignee + monospace time. Sub-rows = indented event children with dotted vertical guide.
- Right rail: flat action queue separated by hairlines — "Overdue invoices · 3 · $4,820", "Estimates to send · 4", "Bills awaiting approval · 3", "Stale quotes · 2 (7+ days)"
- Lower right: "Across all jobs" tertiary activity stream
- Bottom: metric strip (A/R, MTD, YTD, jobs, customers) — present but de-emphasized
- Status dots: pulsing for `in_progress`, grey `scheduled`, green `complete`

**Operational design philosophy:**
- Workflow-oriented, not database-oriented. Every page leads with "what is happening?" first.
- Rejects SaaS-template feel: less border-radius (3-4px), thinner borders, monospace numbers, rule-line dividers instead of card chrome, dense typography, status dots.

**Page hierarchy** — consistent across all 7 domains: `Index list → Show detail → Edit form`. Index pages use `list-utility-bar` with search + filter + "+ New" inline.

**WO show page** — status strip with rule-line dividers, two-column scope + sidebar, custom checkbox visual, progress bar inline, status dot, notes feed metadata-first, sub-WOs as flat divider list, danger zone red rule.

**Mobile responsive** — hamburger-less flex-wrap nav, single-column collapse on phones, denser meta strip.

---

## 10. Technical architecture

**Stack:**
- Node 24 + Express 4 + EJS + HTMX 2 + Tailwind via CDN (no build pipeline) + sql.js (in-memory SQLite, persisted to `data/app.db` with debounced 50ms writes).
- Sessions: `session-file-store` (sql.js compatible) → `connect-pg-simple` on Vercel deploy.
- Auth: bcrypt 10 rounds, session-cookie, role middleware. Planned Supabase Auth with @reconenterprises.net domain restriction + admin invite tokens.

**Routes** — REST-ish with suffix actions: `POST /estimates/:id/send`, `POST /invoices/:id/mark-paid`, `POST /bills/:id/approve`, `POST /work-orders/:id/start`, etc.

**Services layer** (`src/services/`):
- `db.js` — sql.js wrapper. Same shape for upcoming PG version.
- `calculations.js` — server-side subtotal/tax/total with rounding.
- `numbering.js` — atomic next-number via transaction.
- `pdf.js` — pdfkit. Estimate/WO/invoice generators with shared chrome.
- `email.js` — nodemailer. `EMAIL_MODE=file` writes `.eml` to `mail-outbox/` in dev; `=smtp` for Resend on deploy.
- `estimate-email.js` — shared service called by manual route + AI `send_estimate`.
- `accounting-posting.js` — auto-JE posting.
- `audit.js` — single `writeAudit()` entry point.
- `timeline.js` — `buildDayTimeline()`.
- `scheduling.js` — conflict detection + date parsing.
- `ai.js`, `ai-chat.js`, `ai-tools.js` — AI layer.

**PDF:** pdfkit, 3 doc types. Each pulls `company_settings` for header. Logo from `public/logos/recon.png` with text fallback.

**Email:** file-mode writes RFC822 `.eml` with multipart MIME + PDF attachment to `mail-outbox/`. Swap to Resend is one env var flip.

**Deployment target** (Round 22 scoped):
- Vercel serverless Node runtime
- Supabase Postgres via `pg` driver + pgBouncer pooler (port 6543)
- Supabase Storage for `wo_photos`, logo, PDF cache
- Resend for transactional email
- Supabase Auth optional swap

**Bridge architecture:**
- Claude/Hermes file-based bridge with numbered messages
- Python watcher polls + uses `pyautogui` keystroke injection to wake the receiving side
- Pattern: Claude scopes + writes code, Hermes runs commands + verifies

---

## 11. Product identity

**Category:** Construction work-order + dispatch + light double-entry accounting. Field-operations software with bookkeeping built in, not bookkeeping software with field tools bolted on.

**Comparable products:**
- **ServiceTitan** — enterprise HVAC/plumbing. FORGE targets smaller GCs.
- **Jobber** — service-business SaaS. Cleaner consumer aesthetic; FORGE rejects this for operational density.
- **Housecall Pro** — service-trade dispatch. Less accounting depth than FORGE.
- **Buildertrend / JobTread / BuilderPrime** — GC project-management. Strong on docs; FORGE leads with schedule + ledger.
- **QuickBooks** — accounting only. FORGE wraps QB-lite around operations.

**Differentiators:**
- **Operational-software aesthetic** — rule lines, monospace numbers, status dots, dense typography. FORGE wordmark with red gradient.
- **AI chat as first-class operational layer** — read tools + confirm-gated mutation tools. Not a Q&A widget.
- **Schedule-first dashboard** — today's WO timeline with event children is the home page.
- **Integrated double-entry accounting from day one** — events auto-post balanced JEs.
- **Single-tenant initially** — per DECISIONS.md, ship faster.
- **Three-tier identity discipline** — Software = FORGE / Publisher = Recon Enterprises / Operating company = `company_settings.company_name`.

---

## 12. Generated outputs

**1-paragraph product description (website hero):**
> FORGE is field-operations software for general contractors who'd rather see their day than read about it. One screen shows every work order on the schedule — today's, this week's, and the conflicts you don't want to find at 7 AM. Estimates become work orders, work orders become invoices, payments and vendor bills auto-post to a balanced double-entry ledger, and an AI assistant handles search, dispatch, and routine actions with a "confirm before write" safety rail. Built by Recon Enterprises for crews who want operational software, not another SaaS dashboard.

**Technical system summary (3-4 sentences for developers):**
> FORGE is a Node 24 + Express + EJS + HTMX monolith with Tailwind via CDN, currently running on sql.js in-memory SQLite (Postgres-ready via a translated schema for Supabase deploy on Vercel). The data model centers on a work-order spine — Customer → Job → WO (with sub-WOs) → 1:1 Estimate → 1:1 Invoice — plus an independent Vendor → Bill chain, all bottoming out in a double-entry chart-of-accounts + journal_entries + journal_lines ledger with auto-posting on every financial event. A provider-agnostic AI layer (DeepSeek default) exposes ~15 tools across read/navigate/mutate tiers; every mutation flows through a propose → 5-min-expiry confirmation → execute cycle and lands in a per-source audit_logs table. Role-based middleware enforces admin/manager/worker scoping, with workers seeing no prices anywhere — including in AI chat results.

**Non-technical business summary (3-4 sentences for a contractor business owner):**
> FORGE runs your jobs end-to-end on one screen. Your office turns leads into estimates, sends them, schedules the work, dispatches your crew, and bills the customer — and the books (P&L, A/R aging, balance sheet) update themselves as it happens. Your field guys see only their own work orders with no prices, and your office can ask the built-in assistant "what's overdue?" or "schedule WO-1042 for Mike Thursday at 9" instead of clicking through five pages. It's the dispatch board and the bookkeeping in one place, set up for your company alone — no shared tenant, no marketing seats, no per-customer fees.

**Acronym/name analysis:**

**FORGE = Field Operations, Records & General Estimating** — the strongest choice. Covers the schedule (Field Operations), the audit/accounting layer (Records), the estimate→invoice spine (General Estimating). Construction-coded brand, masculine but not aggressive, looks good in a red gradient.

Five alternates that also fit:

1. **ANVIL** — *Active Networks for Vendors, Invoicing & Labor*. Same construction-tool vibe; "active" captures the schedule-first orientation; covers the three financial sub-systems. Pairs with FORGE as a sister product.

2. **SPAN** — *Scheduling, Pricing, Accounting & Notes*. Construction term (structural span); short, hard syllable; expansion describes the four pillars.

3. **TRADES** — *Tracking, Reports, Accounting, Dispatch & Estimating Suite*. Wraps everything into one industry-native word; positioning ("for the trades") embedded in the name.

4. **RIGGER** — *Reporting, Invoicing & General Ground-up Estimating + Recordkeeping*. Construction-coded; the name has personality.

5. **PLUMB** — *Projects, Ledgers, Users, Materials & Bills*. Tradesman term meaning "straight/true"; covers the entity model neatly; shortest and most distinctive of the alternates.

FORGE remains the recommended choice — the red-gradient wordmark in `views/layouts/header.ejs` already carries strong visual identity, and the acronym expansion is honest about what the product does.
