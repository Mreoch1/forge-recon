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
