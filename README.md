# Recon Construction Work Order System

In-house web app for managing the customer-to-cash flow at Recon Construction:

```
Customer  →  Job  →  Estimate  →  Work Order  →  Invoice  →  Paid
```

Built overnight 2026-05-10 by Claude (planner) + Hermes (executor) coordinating via a file-based bridge while Michael slept. Architecture, lessons, and every default we picked without him are in `PROJECT_PLAN.md`, `DECISIONS.md`, and `CHANGELOG.md`. Things waiting on Michael are in `TODO_FOR_MICHAEL.md`.

---

## Quick start

```
npm install
npm run init-db
npm run seed
npm start
```

Open http://localhost:3001 and log in:

- **email:** `admin@recon.local`
- **password:** `changeme123` ← rotate this immediately via Admin > Users.

The app listens on port 3001 because 3000 was occupied by another Next.js service. Set `PORT=3002 npm start` to override.

---

## Daily workflow

1. **Customers.** Create a customer record with contact info.
2. **Jobs.** Each job belongs to a customer and has its own site address + scope description.
3. **Estimates.** From the job page, click "+ New estimate." Add line items (trade / description / qty / unit / unit price). Tax rate auto-fills from company settings. Save as draft.
4. **Send the estimate.** From the estimate page, click "Send" — status flips to `sent`. Customer reviews, you mark accepted or rejected.
5. **Convert to Work Order.** Once accepted, click "Convert to Work Order." Line items copy across. Multiple WOs can be created from one estimate (for phased jobs).
6. **Schedule + assign.** Edit the WO to set a scheduled date and crew lead. Mark line items "done" as work progresses.
7. **Start work / mark complete.** Status flow: `scheduled` → `in_progress` → `complete`. Cancel from any non-complete state.
8. **Generate invoice.** Once a WO is `complete`, click "Generate invoice" on the WO page. The invoice copies WO line items, applies the tax rate from the originating estimate, and sets a 30-day due date.
9. **Send invoice.** Click "Send" on the invoice. Generates a PDF, drops a `.eml` file in `mail-outbox/` (a real email if you've wired SMTP). Status flips to `sent`.
10. **Mark paid.** Use the inline mark-paid form. Partial payments stay `sent`; full payment flips to `paid`.

Every estimate, WO, and invoice has a downloadable PDF with the recon logo, company info, line items, totals, and meta strip.

---

## Tech stack

- **Node.js + Express** — server.
- **SQLite via sql.js** — pure-JS SQLite (no native build deps). Database lives at `data/app.db`.
- **EJS** — server-side templates.
- **HTMX + Tailwind via CDN** — no build pipeline.
- **bcrypt** — password hashing.
- **express-session + session-file-store** — sessions persisted to `sessions/`.
- **pdfkit** — PDF generation.
- **nodemailer** — `EMAIL_MODE=file` writes `.eml` files; `EMAIL_MODE=smtp` sends via real SMTP.

---

## Layout

```
construction-app/
├── src/
│   ├── server.js               entry point
│   ├── routes/                 dashboard / auth / customers / jobs / estimates / work-orders / invoices / admin
│   ├── views/                  EJS templates, one folder per resource
│   ├── middleware/auth.js      requireAuth, requireAdmin, loadCurrentUser, setFlash
│   ├── services/
│   │   ├── numbering.js        atomic EST/WO/INV-YYYY-NNNN generation
│   │   ├── calculations.js     server-authoritative totals math
│   │   ├── pdf.js              pdfkit-based PDF generators (estimate / WO / invoice) + renderToBuffer
│   │   └── email.js            nodemailer wrapper (file-drop or SMTP)
│   └── db/
│       ├── schema.sql          full schema (idempotent)
│       ├── db.js               sql.js wrapper with run / get / all / exec / transaction
│       ├── init.js             applies schema (npm run init-db)
│       └── seed.js             admin user + company settings (npm run seed)
├── public/
│   ├── js/line-items.js        vanilla JS for dynamic line item rows
│   └── logos/recon.png         used in nav + PDF headers
├── test/
│   ├── calculations.test.js    money-safe math
│   └── numbering.test.js       counter format
├── data/                       SQLite DB (gitignored)
├── mail-outbox/                .eml files from sent invoices (gitignored)
├── sessions/                   session files (gitignored)
├── PROJECT_PLAN.md             master plan + memory file
├── DECISIONS.md                every default we picked without you
├── CHANGELOG.md                what got built and when
├── TODO_FOR_MICHAEL.md         your morning checklist
├── HANDOFF.md                  what to do first
└── README.md                   this file
```

---

## Configuration

Environment variables (set via `.env` or shell):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 3001 | HTTP listener port |
| `SESSION_SECRET` | `dev-secret-change-me` | Session signing key — set this in production |
| `EMAIL_MODE` | `file` | `file` writes .eml to mail-outbox/, `smtp` sends via SMTP |
| `EMAIL_FROM` | `"Recon Construction" <noreply@recon.local>` | From header |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | — | Required when `EMAIL_MODE=smtp` |

Application-level config (Admin > Settings):

- Company name, address, phone, email, EIN
- Default tax rate
- Estimate / WO / Invoice number prefixes
- Logo: drop a replacement at `public/logos/recon.png` (any reasonable PNG)

---

## Status flows

**Estimate:** `draft` → `sent` → `accepted` | `rejected`. Edits only allowed in `draft`. Once accepted, "Convert to Work Order" appears.

**Work Order:** `scheduled` → `in_progress` → `complete`, cancellable from any non-complete state. Edits allowed in `scheduled` or `in_progress`. "Generate invoice" appears once `complete`.

**Invoice:** `draft` → `sent` → `paid`, with `overdue` computed for display when `sent` and past due-date. Voidable from any non-paid state. Edits only in `draft`.

---

## Tests

```
npm test
```

Runs Node's built-in test runner against `test/*.test.js`. Currently covers the calculation primitives and the numbering format. Integration tests against the full HTTP stack are listed in TODO for follow-up.

---

## Email-to-file mode

By default, sending an invoice writes a fully-formed RFC822 `.eml` file to `mail-outbox/` instead of transmitting. The `.eml` includes the multipart body and the PDF as an attachment — you can open it directly in Outlook / Thunderbird / Apple Mail to preview what your customer would see.

To switch to real SMTP:

```
EMAIL_MODE=smtp \
SMTP_HOST=smtp.your-provider.com \
SMTP_PORT=587 \
SMTP_USER=ops@recon.com \
SMTP_PASS=app-password \
npm start
```

---

## Known v0 limitations

These are listed (with detail) in `TODO_FOR_MICHAEL.md`. Highlights:

- No customer-facing portal — customers receive PDFs as email attachments.
- No mobile responsive polish — works on phones, optimized for desktop.
- Single-tenant — no per-customer access controls beyond admin/staff roles.
- Tax is single-rate per invoice. Multi-jurisdiction tax is later work.
- Number counters don't auto-reset on year change.
- No reports yet (A/R aging, revenue by trade, jobs by status).
- No audit log of who edited what.

---

## License

Internal use only. Not licensed for redistribution.
