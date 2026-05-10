# Decision log

Append-only. Every architectural decision made without Michael goes here. He can review and reverse anything in the morning.

## 2026-05-10T06:42:00Z — Project location
**Decision:** Built inside `C:\Users\Mreoc\hermes-claude-link\construction-app\` rather than at `C:\Users\Mreoc\construction-app\`.
**Reason:** The bridge folder is the only one mounted into Cowork, so Claude has direct file access here. Functionally optimal. Can be moved later by `git mv` and a re-mount.

## 2026-05-10T06:42:00Z — Stack: Node/Express
**Decision:** Node + Express + EJS + HTMX over Python/Flask.
**Reason:** Michael said "web based over python." Single language across stack, no transpile, fastest path to a working v0 with PDF/email capability.

## 2026-05-10T06:42:00Z — Tailwind via CDN, no build pipeline
**Decision:** Tailwind from CDN script tag rather than PostCSS build.
**Reason:** v0 priority is shippable code, not optimized bundle. Production switch is one config later.

## 2026-05-10T06:42:00Z — Email mocked to file system
**Decision:** Nodemailer configured to write `.eml` files to `mail-outbox/` instead of sending via SMTP.
**Reason:** No real SMTP credentials available, and Michael said no real customer emails. UI flows ("Send invoice") all work end-to-end; the email file lands in `mail-outbox/` for inspection. Real SMTP swap is a one-line config later.

## 2026-05-10T06:42:00Z — Default admin credentials
**Decision:** Seed admin user as `admin@recon.local` / `changeme123`.
**Reason:** Need a working login on first boot. Documented in TODO_FOR_MICHAEL.md as "rotate immediately."

## 2026-05-10T06:42:00Z — Number formats
**Decision:**
- Estimates: `EST-YYYY-NNNN`
- Work Orders: `WO-YYYY-NNNN`
- Invoices: `INV-YYYY-NNNN`
- All counters reset January 1.
**Reason:** Standard pattern in trade.

## 2026-05-10T06:42:00Z — Tax rate
**Decision:** Default tax rate stored in `company_settings.default_tax_rate` (single value), applied as a percentage of subtotal. Override per estimate/invoice if needed.
**Reason:** Single-jurisdiction default keeps v0 simple. Multi-jurisdiction tax is Phase 8+.

## 2026-05-10T06:42:00Z — Sessions in SQLite
**Decision:** `connect-sqlite3` for session store, separate db file.
**Reason:** No Redis/Memcached needed for in-house single-server deployment.

## 2026-05-10T07:00:00Z — SQLite library: sql.js instead of better-sqlite3
**Decision:** Replaced `better-sqlite3` with `sql.js` (pure JavaScript SQLite via Emscripten).
**Reason:** better-sqlite3 requires native compilation via node-gyp, which needs Visual Studio C++ build tools. VS2022 Community is installed but lacks the "Desktop development with C++" workload. Installing it via the VS installer CLI failed (exit code 87, invalid parameter). sql.js is zero-build, works with Node 24 out of the box, and is API-compatible for SQL execution. The DB operations are synchronous within sql.js's async init.

## 2026-05-10T07:00:00Z — Session store: session-file-store instead of connect-sqlite3
**Decision:** Replaced `connect-sqlite3` with `session-file-store`.
**Reason:** connect-sqlite3 wraps better-sqlite3. Since better-sqlite3 was replaced, the session store needed a different backend. File-store persists sessions to disk in sessions/ without native deps.

## 2026-05-10T07:00:00Z — Default port: 3001 instead of 3000
**Decision:** Smoke server defaults to port 3001.
**Reason:** Port 3000 is occupied by another service (Next.js app, PID 29832). Changed default PORT in server.js to 3001 to avoid conflict. Configurable via PORT env var.
