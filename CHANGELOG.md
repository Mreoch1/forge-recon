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
