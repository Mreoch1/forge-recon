# Changelog

Append-only log of every change. Newest at the bottom. Format:

```
## [ISO timestamp] — actor (claude|hermes) — phase
- bullet of what changed
```

## [2026-05-10T06:42:00Z] — claude — phase 0
- Created project skeleton at construction-app/
- Wrote PROJECT_PLAN.md (master memory)
- Wrote package.json (deps locked)
- Wrote .gitignore, README.md, CHANGELOG.md (this), DECISIONS.md, TODO_FOR_MICHAEL.md
- Sent first directive to Hermes (msg 8): npm install, Node version, fetch recon logo, smoke server

## [2026-05-10T07:00:00Z] — hermes — phase 0
- Verified Node v24.15.0 (>= 18)
- npm install succeeded (266 packages) — replaced better-sqlite3 + connect-sqlite3 with sql.js + session-file-store (no VC++ build tools)
- Copied recon logo from recon-ai-hermes/frontend/public/img/recon-logo.png to public/logos/recon.png (334KB)
- Wrote src/server.js — Express app with GET /ping
- Smoke test: `curl http://localhost:3001/ping` returned `{"ok":true,"ts":"2026-05-10T07:00:54.593Z"}`
- Default port changed to 3001 (3000 already in use by another service)
- Initialized git, committed phase 0 skeleton

## [2026-05-10T07:10:00Z] — claude — phase 1 (files)
- Wrote src/db/schema.sql — full schema: users, customers, jobs, estimates + line items, work_orders + line items, invoices + line items, company_settings, indexes
- Wrote src/db/db.js — sql.js wrapper exposing run/get/all/exec/transaction with debounced disk persistence
- Wrote src/db/init.js — applies schema on `npm run init-db`
- Wrote src/db/seed.js — seeds admin (admin@recon.local / changeme123) + company_settings singleton
- Wrote src/middleware/auth.js — requireAuth, requireAdmin, loadCurrentUser, setFlash
- Wrote src/routes/auth.js — GET/POST /login, POST /logout (bcrypt verify, generic error on fail)
- Wrote src/views/layouts/header.ejs + footer.ejs — base layout, red/black/grey theme, Inter font, nav bar with logo, flash banner
- Wrote src/views/auth/login.ejs — login page with logo
- Wrote src/views/dashboard/index.ejs — placeholder with KPI cards + "getting started" CTA
- Wrote src/views/error.ejs — 404/500 page
- Rewrote src/server.js — full app: helmet, morgan, sessions (file-store), EJS views, static, body parsers, /ping (public), /login + /logout + / (dashboard, gated), 404 + 500 handlers

## [2026-05-10T07:13:00Z] — hermes — phase 1
- Ran `npm run init-db` — DB created at data/app.db, schema applied
- Ran `npm run seed` — admin user + company_settings row created
- Smoke tested all 8 auth flow steps (anonymous redirect, login render, valid login, gated dashboard, already-logged-in redirect, logout, bad password 401, /ping public): all green
- bcrypt installed cleanly (prebuilt binary for Node 24/Windows)
- sql.js wrapper worked as-is, no patches needed
- EJS includes resolved on Windows paths
- Killed stale PID on port 3001
- Updated .gitignore to include data/, sessions/, node_modules/
- Committed dc48eae (15 files, 891+/12-)

## [2026-05-10T07:25:00Z] — claude — phase 2A (files)
- Wrote src/routes/customers.js — list (search + pagination, 25/page), new, create (validation, redirect on err), show (with linked jobs), edit, update, delete (FK guard against existing jobs)
- Wrote src/views/customers/_form.ejs — shared form partial for new+edit
- Wrote src/views/customers/index.ejs — list with search + pagination
- Wrote src/views/customers/new.ejs — wraps shared form
- Wrote src/views/customers/edit.ejs — wraps shared form, plus delete-button danger zone
- Wrote src/views/customers/show.ejs — contact panel + jobs table
- Updated src/server.js — mount /customers under requireAuth

## [2026-05-10T07:30:00Z] — hermes — phase 2A (partial + bug fix)
- Found bug: `emptyToNull` used `trim()` which returned `undefined` for non-string fields. sql.js rejects undefined param binds with a malformed error. Patched: type-check first, return null for non-strings.
- Verified: GET /customers (200 empty), GET /customers/new (200), POST blank name (400), POST bad email (400), POST valid (302 to /customers/2)
- Pending: show, search hit/miss, edit form, update, delete, FK guard, cleanup — to complete in next session

## [2026-05-10T07:40:00Z] — claude — phase 2B (files)
- Wrote src/routes/jobs.js — full CRUD, validates customer_id exists, status enum, applied lessons from 2A bug (typed emptyToNull from the start, no trim() crash path)
- Wrote src/views/jobs/_form.ejs — shared form partial with customer dropdown + status select
- Wrote src/views/jobs/index.ejs — list with search box + status filter + paginated, joins customer name
- Wrote src/views/jobs/new.ejs — wraps _form, /jobs/new redirects to /customers/new if no customers exist (with flash)
- Wrote src/views/jobs/edit.ejs — wraps _form + delete danger zone (FK guard messaging)
- Wrote src/views/jobs/show.ejs — header w/ status badge + customer link, 3 info cards (job site/customer/description), 3 stacked sections (Estimates/Work Orders/Invoices) with empty states
- Updated src/server.js — mount /jobs under requireAuth

## [2026-05-10T07:40:00Z] — hermes — phase 2 complete
- 18-step Phase 2A test pass: all green (create, show, search, edit, update, delete, FK guard, cross-link)
- 19-step Phase 2B test pass: all green (no-customers gate, customer dropdown, prefill, validation, search across title+customer, status filter, FK guard against estimates)
- Discovery: sql.js per-process — CLI inserts don't reach a running server's in-memory copy. Documented in DECISIONS.md.

## [2026-05-10T07:50:00Z] — claude — phase 3A (files)
- Wrote src/services/numbering.js — atomic next-number via transaction, formats EST/WO/INV-YYYY-NNNN
- Wrote src/services/calculations.js — server-side authoritative subtotal/tax/total, money-safe rounding
- Wrote src/routes/estimates.js — full CRUD + status actions (send/accept/reject) + delete with WO FK guard. Edits restricted to draft only. Forces job_id from existing record on update (no re-parenting via form).
- Wrote src/views/estimates/_form.ejs — line items table with hidden template row, totals tfoot, tax_rate input, hidden job_id, Notes textarea
- Wrote src/views/estimates/index.ejs — list with search + status filter
- Wrote src/views/estimates/new.ejs, edit.ejs — both wrap _form
- Wrote src/views/estimates/show.ejs — totals cards (subtotal/tax/total in dark hero), line items table, dates panel, status-aware action buttons (Send / Accept-Reject / Edit / Delete), PDF link present (404 until 3B)
- Wrote public/js/line-items.js — vanilla JS, add/remove rows, live calc, reindexes lines[N] names on remove, prevents removing last row
- Updated src/views/jobs/show.ejs — "+ New estimate" link now /estimates/new?job_id=X
- Updated src/server.js — mount /estimates under requireAuth

## [2026-05-10T07:52:00Z] — hermes — phase 3A complete
- All 24 Phase 3A steps green: gates, validation, math (subtotal 21500, tax 1612.50 at 7.5%, total 23112.50), edit-only-when-draft, status flow draft->sent->accepted, status guards block invalid transitions, FK guard against work_orders blocks delete
- Numbering: EST-2026-0001 first create, increments to 0002 second
- line-items.js shipped, browser test deferred (curl can't run JS)

## [2026-05-10T08:00:00Z] — claude — phase 3B (files)
- Wrote src/services/pdf.js — pdfkit-based estimate PDF: header (logo + company info right-aligned), title, two-column Bill-to/Job-site blocks, line items table with cloud header bg + mist row borders, right-aligned totals stack with red total amount, notes block, footer meta line. Page-break safety in line items table. Falls back to text-only header if logo missing.
- Updated src/routes/estimates.js: enriched loadEstimate query to pull customer + job address fields needed by PDF. Added GET /:id/pdf route streaming pdfkit to response. Supports ?download=1 for forced save vs inline preview.
- Updated src/views/estimates/show.ejs — split single PDF button into "View PDF" (inline new tab) + "Download" (?download=1)

## [2026-05-10T08:05:00Z] — hermes — phase 3B complete
- 7 PDF tests green: magic bytes %PDF-1.3, inline + download dispositions, 404, logo-missing fallback (text header, no crash), 30-line page break (260KB, no crash). Sample PDFs saved in bridge folder.

## [2026-05-10T08:15:00Z] — claude — phase 4 (files)
- Wrote src/routes/work-orders.js — full CRUD + status transitions (start/complete/cancel) + PDF + delete (FK guard against invoices). Edit allowed only while scheduled or in_progress. Per-line completed checkbox.
- Updated src/routes/estimates.js — added POST /:id/convert-to-wo. Only allowed when estimate.status='accepted'. Copies line items into work_order_line_items in transaction. Generates next WO number. Multiple conversions allowed (estimate can spawn N WOs for phased jobs).
- Updated src/services/pdf.js — added generateWorkOrderPDF: same chrome as estimate PDF + 4-column meta strip (status / scheduled / assigned / completed) + line items table with extra "Done" checkbox column + "Total value" footer (no tax/total breakdown — WO is internal). Falls back to estimate-style chrome.
- Wrote src/views/work-orders/index.ejs — list with search + status filter
- Wrote src/views/work-orders/edit.ejs — schedule + assigned_to + line items table with completed checkboxes (uses line-items.js for add/remove/calc)
- Wrote src/views/work-orders/show.ejs — header w/ status badge + estimate backlink, 4 KPI cards (scheduled/assigned/progress/total), invoice-generated banner if linked, line items with done checkmarks, status-aware action buttons (start / complete / cancel / generate invoice / delete)
- Updated src/views/estimates/show.ejs — added "Convert to Work Order" button when estimate.status='accepted'
- Updated src/server.js — mount /work-orders under requireAuth

## [2026-05-10T08:18:00Z] — hermes — phase 4 complete
- 22 steps green: convert flow with status guards, multiple conversions, line item copy, full WO lifecycle, PDF with DONE column, cancel + delete, FK guard against invoices.

## [2026-05-10T08:30:00Z] — claude — phase 5 (files, full bundle)
- Wrote src/services/email.js — nodemailer wrapper, EMAIL_MODE=file (default) writes RFC822 .eml to mail-outbox/, EMAIL_MODE=smtp wires real SMTP via env vars
- Wrote src/routes/invoices.js — full CRUD + status actions:
  - GET / list, GET /:id show (with overdue display computation), GET /:id/edit + POST /:id update (draft only)
  - POST /:id/send: generates PDF buffer, calls email.sendEmail, updates status='sent', sent_at=now
  - POST /:id/mark-paid: with amount input — partial payments stay 'sent', full payment flips to 'paid' + paid_at
  - POST /:id/void: any non-paid -> void
  - GET /:id/pdf, POST /:id/delete (only draft/void)
- Updated src/services/pdf.js — added generateInvoicePDF (mirror chrome + 4-cell meta strip status/issued/due/amount-paid + balance-due red callout when outstanding) AND renderToBuffer helper for email attachment
- Updated src/routes/work-orders.js — added POST /:id/generate-invoice. WO must be complete + no existing invoice. Pulls tax_rate from originating estimate or company default, copies line items, due_date = today+30d. Generates next invoice number. 1:1 WO->invoice in v0.
- Wrote src/views/invoices/index.ejs — list with overdue computed display, balance column highlights red when outstanding
- Wrote src/views/invoices/edit.ejs — line items + tax + due date editor (draft only)
- Wrote src/views/invoices/show.ejs — header w/ WO backlink, 4 KPI cards (subtotal/tax/total/balance — balance card flips green when paid), inline mark-paid form (toggle visible, defaults amount to balance), status-aware action buttons (Send / Mark paid / Void / Delete-when-draft-or-void)
- Updated src/server.js — mounted /invoices under requireAuth

## [2026-05-10T08:32:00Z] — hermes — phase 5 complete
- 22 steps green: invoice generation from completed WO, edit, send (.eml lands in mail-outbox/ with multipart + PDF attachment), partial+full payment with status flips, void, overdue auto-display, FK guards, sample-INV-2026-0001.pdf saved.

## [2026-05-10T08:40:00Z] — claude — phase 6 (files)
- Wrote src/routes/dashboard.js — extracted from server.js. Pulls live KPIs: open estimates, active WOs, unpaid invoices, A/R balance, overdue count + balance, revenue this month, revenue YTD, customer + job counts. Unified activity feed (latest 10 estimates/WOs/invoices via UNION ALL).
- Updated src/views/dashboard/index.ejs — full redesign: 4 clickable KPI cards (drill into filtered list views), 3 revenue/context cards, recent-activity timeline with type badges, status badges, customer + job + amount inline.
- Wrote src/routes/admin.js — user CRUD + settings:
  - GET/POST /admin/users (list, create with name/email/role/password)
  - GET/POST /admin/users/:id/edit + update (name/email/role/active toggle)
  - POST /admin/users/:id/password (separate endpoint for password reset)
  - POST /admin/users/:id/delete (refuses self-delete + last-active-admin protection)
  - GET/POST /admin/settings (company singleton — name, address, contact, EIN, default tax rate, prefixes)
- Wrote src/views/admin/users/index.ejs (table with role + status badges, "you" indicator)
- Wrote src/views/admin/users/new.ejs (name + email + role + password, 8+ char min)
- Wrote src/views/admin/users/edit.ejs (profile form + inline change-password section + danger zone — delete hidden when isSelf)
- Wrote src/views/admin/settings.ejs (3 sections: identity, address, defaults+numbering — counters shown read-only)
- Updated src/server.js — extracted dashboard route, mounted /admin under requireAuth + requireAdmin

## [2026-05-10T08:42:00Z] — hermes — phase 6 complete
- 22 steps green: live KPIs, activity feed surfacing all 3 entity types, admin user CRUD, validation (short password / dup email), self-demote and self-delete guards, password reset, settings update, default tax rate auto-fill on new estimate, staff user blocked from /admin.

## [2026-05-10T08:50:00Z] — claude — phase 7 (files)
- Wrote test/calculations.test.js — 11 assertions: round2, lineTotal happy + zero/missing/invalid, totals empty/zero-tax/invalid-tax/non-array/large-quantities, and the canonical 7.5% on $21,500 = $23,112.50.
- Wrote test/numbering.test.js — 4 assertions: format() padding + year, large numbers, custom prefix, _nextNumber rejects unknown field.
- Rewrote README.md — comprehensive: quick start, daily workflow, tech stack, layout tree, configuration env vars, status flows table, test instructions, email-mode swap, known limitations.
- Wrote HANDOFF.md — Michael's morning briefing: how to run, mandatory first-3-minutes rotations, end-to-end test workflow, troubleshooting, one-paragraph overnight summary.
- Updated PROJECT_PLAN.md — added "v0 Hand-off summary" section at top with phase-by-phase recap.

## [2026-05-10T08:35:00Z] — hermes — phase 7 complete — v0 SHIPPED
- npm test: 14/14 green (11 calculation + 3 numbering)
- Full money-loop E2E smoke: 12 steps all 2xx/3xx; total carried through from estimate $23,112.50 → invoice → mark paid
- Activity feed surfaces all 3 entity types
- 58 tracked files
- Hermes sign-off: "v0 is shippable. Ready for Michael's morning review."

## [2026-05-10 ~mid-day] — claude — v0.5 IN PROGRESS (schema + routes done, views pending)
- Bug fix: estimate/WO/invoice forms accepting blank line items now drop description-less rows silently instead of failing validation. Fix applied to all 3 line-item routes.
- Schema rewrite: WO is root document. customer→job→WO→estimate→invoice. Sub-WOs via parent_wo_id self-FK. Unified parentMain-sub numbering "0001-0000" carries through all four types.
- Added: billing_email on customers, cost column on every line-item table (internal), payment_terms on invoices (Due on receipt / Net 15/30/45/60 / Custom), scheduled_date/scheduled_time/assigned_to_user_id on jobs and WOs, items_library/wo_notes/wo_photos placeholder tables, admin/manager/worker role triple.
- Numbering: single counter (next_wo_main_number) replaces three. Editable on creation forms.
- Routes rewritten: customers, jobs (auto-fill site from customer), work-orders (root + sub-WO + create-estimate action), estimates (created from WO, selected line checkbox, generate-invoice action), invoices (created from estimate, billing_email recipient, payment_terms presets).
- Auth middleware: requireManager added between requireAuth and requireAdmin. Pricing-routes now require admin or manager; workers can only hit /work-orders.
- server.js: route mount permissions updated.
- **VIEWS NOT YET REWRITTEN.** App will crash on most pages until views catch up to new schema. TODO_FOR_MICHAEL has the full list.
- DO NOT run `npm run init-db` against v0 data — schema is incompatible.

## [2026-05-10T07:12:00Z] — hermes — phase 1
- Ran npm run init-db → DB initialized at data/app.db (118KB)
- Ran npm run seed → admin user seeded (idempotent on re-run), company_settings seeded
- Verified bcrypt works (installed cleanly, no VC++ dependency issue)
- Booted server on port 3001 (killed stale PID 25304 first)
- Auth smoke test: 7/7 pass + negative test pass
  - /ping → 200 JSON
  - / (no auth) → 302 → /login
  - /login → 200 HTML
  - POST /login (valid) → 302 + Set-Cookie
  - / (with cookie) → 200 dashboard
  - /login (already logged in) → 302 → /
  - POST /logout → 302 → /login
  - POST /login (bad password) → 401 "Invalid email or password"
- All routes working, no sql.js async issues, no EJS include path problems
- Committed: dc48eae

## [2026-05-10T07:28:00Z] — hermes — phase 2a
- Installed routes + views for Customers CRUD (written by Claude)
- Fixed bug: emptyToNull() returned undefined for missing form fields; sql.js crashes on undefined bind params. Changed to return null.
- Confirmed: GET /customers (200), GET /customers/new (200), POST create valid (302 → /customers/2), validation works (400 with errors)
- Full 17-step test interrupted by blocked commands — will complete on next bridge check

## [2026-05-10T07:38:00Z] — hermes — phase 2 (complete)
- 2A: Customers CRUD — all 18 steps pass (create, show, search, update, delete, FK guard against jobs)
- 2B: Jobs CRUD — all 19 steps pass (create with customer dropdown, prefilled form, validation, search/filter, update, delete, FK guard against estimates)
- Note: sql.js in-memory persistence means CLI-based FK guard tests require server restart to pick up disk changes

## [2026-05-10T07:50:00Z] — hermes — phase 3a
- Estimates CRUD with line items: create, show, edit, update, status transitions all pass
- Server-side total calculation confirmed: subtotal 21500, tax 1612.50, total 23112.50
- Numbering generates EST-2026-0001 and increments properly
- Status machine: draft→sent (locked from edit), sent→accepted, invalid transitions refused cleanly
- FK guard: delete blocked when WO references exist, shows "Cannot delete — 1 work order(s) reference it"
- line-items.js on disk, client-side add/remove/calc ready for browser testing
- All 24 test steps pass end-to-end

## [2026-05-10T07:58:00Z] — hermes — phase 3b
- PDF generation via pdfkit: inline (200, application/pdf, 259KB) and download (?download=1, attachment)
- Logo in top-left, company info top-right, estimate title, bill-to/job-site, line items table, totals stack (subtotal/tax/total), notes block, footer meta
- Logo missing fallback: generates cleanly as text-only header (2616 bytes, no crash)
- 30-line page break test: generates without error (260KB), multi-page table continuation
- Sample PDFs saved to bridge folder: sample-EST-2026-0003.pdf, sample-30line-pagebreak.pdf

## [2026-05-10T08:10:00Z] — hermes — phase 4
- Work Orders CRUD: create, show, edit, update with line completion, start, complete, cancel, delete
- Estimate→WO conversion: 2 conversions from same estimate (phased work), line items copied, status gated to 'accepted'
- WO PDF: inline, download, logo, meta strip (status/scheduled/assigned/completed), DONE column with X marks, Total value
- Status machine: scheduled→in_progress→complete (cancelled from scheduled/in_progress). Edit blocked after complete.
- FK guard: delete blocked when invoices reference the WO
- All 22 test steps pass end-to-end

## [2026-05-10T08:18:00Z] — hermes — phase 5
- Invoices CRUD: generate from completed WO, edit (draft-only), send (with email + PDF), mark-paid (partial + full), void, delete (draft/void only)
- Email via nodemailer file mode: .eml files written to mail-outbox/ (From, To, Subject, PDF attachment verified)
- Partial payment: status stays 'sent', amount_paid recorded, balance still red
- Overdue auto-display on show page + list when sent + past due_date
- Invoice PDF: inline/download, meta strip, line items, totals, amount-due callout
- All 22 test steps pass end-to-end

## [2026-05-10T08:30:00Z] — hermes — phase 6
- Dashboard with live KPIs (open estimates, active WOs, unpaid invoices, A/R balance, revenue MTD/YTD, customer/job counts) + activity feed
- Admin user CRUD: create, edit, password reset, delete, self-protection guards (can't delete/demote self, last-admin protection)
- Company settings: address, phone, email, EIN, tax rate, prefixes (flows through to estimate PDF header)
- Default tax rate auto-fills on new estimate form
- Staff users blocked from /admin/* routes
- All 22 test steps pass via functional checks

## [2026-05-10T08:32:00Z] — hermes — phase 7 (final)
- Unit tests: 14/14 pass (calculations.test.js + numbering.test.js)
- E2E smoke: full money loop (customer → job → estimate → WO → invoice → paid) all pass
- README rewritten with quick-start, workflow walkthrough, config, test instructions
- HANDOFF.md created with Michael's morning briefing
- PROJECT_PLAN.md updated with v0 handoff summary
- Tracked files: 58
- **v0 complete**

## [2026-05-10T09:00:00Z] — hermes — v0.5 + accounting skeleton
- Fixed admin/settings.ejs: removed prefix fields, added default_payment_terms dropdown, single WO main number counter
- Updated admin.js POST /settings handler for new company_settings columns
- QB-lite accounting skeleton: schema-accounting.sql, init-accounting.js (seeds 24 starter accounts), routes + 6 view stubs
- Added /accounting route under requireManager + nav link in header
- Added npm run init-accounting script
- Updated TODO_FOR_MICHAEL.md with next-session accounting work items

## [2026-05-10T09:30:00Z] — hermes — v0.5: vendors CRUD + accounting report views
- Vendors CRUD (routes + 6 views + nav link) — same pattern as customers, with expense-account dropdown
- Accounting reports: trial-balance (table with Dr/Cr columns + balanced check), profit-loss (revenue/expense/net income), balance-sheet (assets/liabilities/equity with balanced check)
- Mounted /vendors under requireManager in server.js
- Nav link for Vendors between Invoices and Accounting
- v0.5 E2E: core CRUD (customer/job/WO/estimate/invoice creation) works; invoice show/send/mark-paid has JOIN issue in loadInvoice (needs Claude review)

## [2026-05-10T09:45:00Z] — hermes — v0.6 retest
- Fixed `fmt` function not passed to accounting report views (EJS 500)
- Verified invoice show page works (200, was 404)
- Verified invoice send (302, .eml created), mark paid (302)
- Verified accounting auto-posting: journal entries created on send + pay
- Trial balance balanced (Dr $5,375 = Cr $5,375), P&L ($5k revenue), Balance sheet balanced
- All reports render with live data

## [2026-05-10T13:55:00Z] — hermes — v0.7 Round 7: bills CRUD views + JE fix
- Created `src/views/bills/` with 5 views (index, _form, new, edit, show) following vendors/customers/estimates patterns
- `_form.ejs` uses line-items.js for dynamic line add/remove with account_id dropdown per row (expense accounts)
- `show.ejs` has full status-aware buttons: draft→approve/void, approved→pay/void, void→delete
- Added "Bills" nav link in header.ejs between Vendors and Accounting
- Fixed `bills.js` validateBill to fall back to Miscellaneous (5900) when account_id is null (NOT NULL constraint fix)
- **Known issue (fixed in msg 24)**: bill approve JE fails with imbalance — line debits ($325) + tax ($24.50) ≠ AP credit ($349.50). postBillApproved not including tax_amount in debit lines. Silent try/catch swallow.

## [2026-05-10T14:15:00Z] — hermes — msg 24: bill JE fix verified + AI service live + AI-assisted WO UI
- **Task 1**: Verified bill JE fix — init-accounting seeded 5950 (Sales Tax — Vendor Bills). Bill approve JE now has 4 balanced lines (DR Materials $250, DR Materials $75, DR Sales Tax $24.50, CR AP $349.50). Trial balance: $1,048.50 Dr = $1,048.50 Cr.
- **Task 2**: AI service test — `extractWorkOrder` produced valid extraction (customer, job, 4 line items, warnings, 1247 tokens). Customer name prompt needs tuning ("Manager at Plymouth square" vs "Plymouth Square") but output shape is correct.
- **Task 3**: AI-assisted WO creation UI built:
  - `src/views/work-orders/ai-create.ejs` — textarea form with example text
  - `src/views/work-orders/ai-create-preview.ejs` — review page with editable customer/job/assignees/line items, warnings callout
  - Routes: GET/POST /work-orders/ai-create, POST /work-orders/ai-finalize (creates customer → job → WO in transaction)
  - Added "+ AI work order" button to WO index
  - Fixed `router.get('/ai-create')` placement before `/:id` routes (Express collision)
  - Added `require('dotenv').config()` to server.js so AI_API_KEY is available at runtime
- Full E2E test: paste free text → AI extracts → review → finalize → WO-0001-0000 created with customer + job + 3 line items.

## [2026-05-10T14:40:00Z] — hermes — Round 10: line-items regex fix + WO depricing + invoice-time line selection + profit/ROI + WO# linkback
- **Regex fix verified**: line-items.js `/^lines\\[[^\\]]+\\]/` matches `__IDX__` template and digit indices
- **WO depricing**: stripped unit_price/cost/line_total from WO _form.ejs, show.ejs, and PDF (drawWOLineItems is now Done/Description/Qty/Unit only; "Total value" section removed)
- **Invoice-time line selection**: removed "Selected" checkbox from estimate form; POST /generate-invoice now redirects to new GET /select-for-invoice page with per-line checkboxes; form POSTs back with `selected_lines[]` to generate invoice with only checked lines
- **Profit/ROI display**: estimate show page shows Cost/Profit/ROI strip (admin/manager only, hidden when cost=0); estimates index has Margin % column
- **WO linkback prominent**: estimate show header now shows `← WO-XXXX-XXXX` as a click-through link
- All 9 smoke steps pass: WO no pricing, estimate no Selected, select-for-invoice page renders, invoice generated with selected lines, trial balance still balanced
