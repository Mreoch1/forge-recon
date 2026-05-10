# Recon Construction Work Order System

In-house web app: customers -> jobs -> estimates -> work orders -> invoices.

Built overnight by Claude (planner) and Hermes (executor) via the bridge in `../`. See `PROJECT_PLAN.md` for the full architecture and current state. See `CHANGELOG.md` for what got done. See `TODO_FOR_MICHAEL.md` for things waiting on you.

## Quick start

```
npm install
npm run init-db
npm start
```

Default admin login (rotate immediately): `admin@recon.local` / `changeme123`

## Stack

Node + Express + SQLite + EJS + HTMX + Tailwind (CDN). PDFs via pdfkit. Email mocked to `mail-outbox/` as `.eml` files until real SMTP is configured.

## Layout

- `src/server.js` — entry
- `src/routes/` — route modules
- `src/views/` — EJS templates
- `src/middleware/` — auth, etc.
- `src/services/` — pdf, email, numbering
- `src/db/` — schema, init, seeds
- `public/` — static assets, logos, uploaded docs
- `test/` — node:test suites
