# Construction Work Order System — PROJECT PLAN

**THIS IS THE MASTER MEMORY FILE.** Both Claude and Hermes MUST read this at the start of every session before doing anything else. It is the single source of truth for what has been done, what is being done, and what comes next.

---

## Operating rules (do not violate)

1. **Never block on Michael.** If something needs his judgment, write it to `TODO_FOR_MICHAEL.md` and move on. Do not stop the train.
2. **Local only.** No deploys to the internet. No real API keys. No sending real emails to real customers (use a local mock/file-drop for emails until Michael wires real SMTP). No payment integrations.
3. **Stay in this folder.** All work happens inside `C:\Users\Mreoc\hermes-claude-link\construction-app\` and the bridge folder. Do not touch other locations on the Windows host.
4. **No destructive operations.** No `rm`, no DROP TABLE, no force-pushes, no overwrites without backup. If a file needs to be replaced, write to a new file or comment-out the old block.
5. **Log every directive executed** to `executed.log` in the bridge folder (append-only) and update **CHANGELOG.md** in this folder.
6. **Always reply on the bridge.** Even "blocked, here's why" — never silent.
7. **Do not check with Michael for clarification.** Use sensible defaults and document them in DECISIONS.md.

## Stack

- Node.js + Express
- SQLite via better-sqlite3
- Sessions via express-session + connect-sqlite3
- bcrypt for password hashing
- EJS for server-side templates
- HTMX for partial-page interactivity (CDN, no build)
- Tailwind CSS via CDN (no build pipeline for v0)
- pdfkit for PDF generation
- nodemailer for email (configured to write .eml files to `mail-outbox/` as the local "mock SMTP")
- helmet, morgan for security/logging
- Native node:test for tests

Theme: red / black / grey. Logo: recon (Hermes to fetch from existing recon-ai-hermes folder).

## Data model

**users**: id, email (unique), password_hash, name, role ('admin'|'staff'), created_at, updated_at

**customers**: id, name, email, phone, address, city, state, zip, notes, created_at, updated_at

**jobs**: id, customer_id (FK), title, address, city, state, zip, description, status ('lead'|'estimating'|'scheduled'|'in_progress'|'complete'|'cancelled'), created_at, updated_at

**estimates**: id, job_id (FK), estimate_number (unique, auto), status ('draft'|'sent'|'accepted'|'rejected'|'expired'), subtotal, tax_rate, tax_amount, total, valid_until, notes, sent_at, accepted_at, created_at, updated_at

**estimate_line_items**: id, estimate_id (FK), trade ('general'|'electrical'|'plumbing'|'hvac'|'framing'|'drywall'|'paint'|'flooring'|'cabinetry'|'roofing'|'other'), description, quantity, unit ('ea'|'hr'|'sqft'|'lf'|'ton'|'lot'), unit_price, line_total, sort_order

**work_orders**: id, job_id (FK), estimate_id (FK, nullable), wo_number (unique, auto), status ('scheduled'|'in_progress'|'complete'|'cancelled'), scheduled_date, completed_date, assigned_to, notes, created_at, updated_at

**work_order_line_items**: id, work_order_id (FK), trade, description, quantity, unit, unit_price, line_total, completed (bool), sort_order

**invoices**: id, job_id (FK), work_order_id (FK), invoice_number (unique, auto), status ('draft'|'sent'|'paid'|'overdue'|'void'), subtotal, tax_rate, tax_amount, total, amount_paid, due_date, sent_at, paid_at, notes, created_at, updated_at

**invoice_line_items**: id, invoice_id (FK), description, quantity, unit, unit_price, line_total, sort_order

**company_settings** (singleton row): id (always 1), company_name, address, city, state, zip, phone, email, ein, default_tax_rate, invoice_prefix, estimate_prefix, wo_prefix, next_invoice_number, next_estimate_number, next_wo_number, logo_path

**sessions**: managed by connect-sqlite3 in a separate db file.

## Page list (v0 scope)

Auth: GET /login, POST /login, POST /logout
Dashboard: GET /
Customers: GET /customers, GET/POST /customers/new, GET /customers/:id, GET/POST /customers/:id/edit
Jobs: GET /jobs, GET/POST /jobs/new, GET /jobs/:id (tabs for estimates/WOs/invoices), GET/POST /jobs/:id/edit
Estimates: GET /estimates, GET/POST /jobs/:id/estimates/new, GET /estimates/:id, GET/POST /estimates/:id/edit, GET /estimates/:id/pdf, POST /estimates/:id/send, POST /estimates/:id/convert-to-wo
Work Orders: GET /work-orders, GET /work-orders/:id, GET/POST /work-orders/:id/edit, GET /work-orders/:id/pdf, GET /work-orders/:id/print, POST /work-orders/:id/generate-invoice
Invoices: GET /invoices, GET /invoices/:id, GET/POST /invoices/:id/edit, GET /invoices/:id/pdf, POST /invoices/:id/send, POST /invoices/:id/mark-paid
Admin: GET /admin/users, GET/POST /admin/users/new, GET/POST /admin/users/:id/edit, POST /admin/users/:id/disable, GET/POST /admin/settings

## Phase plan (overnight)

**Phase 0 — Skeleton** (Hermes):
- npm install
- Verify Node version
- Fetch recon logo from C:\Users\Mreoc\recon-ai-hermes\ (or wherever) -> public/logos/recon.png
- Run a smoke server (just /ping) and confirm it boots

**Phase 1 — Auth + DB foundation** (Claude writes, Hermes runs/tests):
- src/db/init.js (schema apply, seeding)
- src/db/schema.sql
- src/middleware/auth.js (requireAuth, requireAdmin)
- src/routes/auth.js (login/logout)
- src/views/layouts/main.ejs (base layout w/ nav, theme)
- src/views/auth/login.ejs
- Seed admin user: admin@recon.local / changeme123 (logged to TODO_FOR_MICHAEL.md as "rotate this!")

**Phase 2 — Customers + Jobs**

**Phase 3 — Estimates + line items + PDF**

**Phase 4 — Estimate → WO conversion + WO CRUD + PDF/print**

**Phase 5 — WO → Invoice generation + Invoice CRUD + PDF + email-to-file**

**Phase 6 — Dashboard + admin user mgmt + admin settings**

**Phase 7 — Tests + polish + README**

## Current state

- Phase: 3A (Estimates CRUD + line items + status actions) — Claude written, Hermes verifying.
- Phase 0/1/2A/2B complete. 37-step test pass on Phase 2.
- Phase 3A files in place: numbering service, calculations service, estimates routes, _form with dynamic line items, index/new/edit/show views, line-items.js client UX. Server.js mounts /estimates. jobs/show.ejs updated to link via /estimates/new?job_id=N.
- PDF route (GET /estimates/:id/pdf) is referenced from show.ejs but not yet implemented — Phase 3B will add it. Returns 404 until then.
- Edits are restricted to draft estimates. Once sent/accepted/rejected, edit form refuses with flash. job_id is forced from the existing record on update (form can't re-parent the estimate).
- Status flow: draft -> sent -> accepted/rejected. expired status exists in schema but no auto-transition yet (Phase 6+).

## Important pattern: optional form fields

Any optional form field that's not submitted (empty form input, missing field) arrives as `undefined`. sql.js rejects `undefined` binds. ALL optional fields MUST be normalized through `emptyToNull(v)` (the patched version) before binding. The patched version:

```js
function emptyToNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
```

This is in customers.js and jobs.js. For Phase 3+ (estimates/WOs/invoices) routes, copy this exact helper or extract to a shared lib. Future Claude or Hermes — when you write a new route, grep for `trim(` and make sure it never reaches a `db.run(...)` parameter array.

## Boot sequence for every session

**Hermes**, on every wake:
1. Read PROJECT_PLAN.md (this file)
2. Read DECISIONS.md
3. Read CHANGELOG.md
4. Read latest unread directive from claude_to_hermes.md
5. Execute the directive, working around any blockers
6. Update CHANGELOG.md with what you did
7. If a decision was made without Michael, append to DECISIONS.md
8. If Michael needs to do something, append to TODO_FOR_MICHAEL.md
9. Write reply to hermes_to_claude.md (always reply, even if blocked)
10. Append entry to executed.log

**Claude**, on every wake:
1. Read PROJECT_PLAN.md (this file)
2. Read DECISIONS.md, CHANGELOG.md, TODO_FOR_MICHAEL.md
3. Read latest Hermes reply from hermes_to_claude.md
4. Plan next directive
5. Update PROJECT_PLAN.md "Current state" section
6. Write next directive to claude_to_hermes.md
7. Embed reminder in directive: "don't check with Michael, work around blockers, always reply"
