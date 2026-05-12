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

## 2026-05-10T07:38:00Z — sql.js persistence behavior for testing
**Decision:** Each process has its own in-memory sql.js copy. Persist-to-disk happens after writes (debounced 50ms) but does NOT reload other processes' instances. To test FK guards with manually-injected data, restart the server after CLI inserts so it picks up the latest disk state.
**Reason:** sql.js is in-memory by design. Not a bug — a constraint of the library choice.

## 2026-05-10 — v0.6 architecture: stay on Node/sql.js, swap pieces incrementally
**Decision:** Michael's expanded vision (per his GPT-5.5 conversation) reaches toward a SaaS-style stack: Vercel + Supabase + Stripe + Resend + Plaid + AI APIs. We are NOT pivoting wholesale. v0.5 already works on Node + Express + sql.js + EJS, and every external service Michael wants can be added to this stack via npm packages:
- Plaid: `plaid` SDK — works in any Node app
- Stripe: `stripe` SDK — works in any Node app; webhook receiver added as a public-but-tunneled endpoint when needed
- Resend: `resend` SDK or just point nodemailer at smtp.resend.com — drop-in transport swap
- AI extraction: HTTP calls to OpenAI / Anthropic / DeepSeek — framework-agnostic
- Supabase: optional. Postgres via `pg` npm package gets us a hosted DB without rewriting the data layer; sql.js → pg is a query-driver swap, not an architecture rewrite. Defer until single-tenant local breaks at scale.
- Vercel: optional. Defer until we need public access. For now app runs on Michael's box.

**Reason:** Throwing out v0.5 and rebuilding on Next.js+Supabase would burn ~2 sessions of work for zero functional gain. The current stack handles everything in the vision; the SaaS pieces are feature additions, not architectural prerequisites.

## 2026-05-10 — Plaid for bank-balance integration
**Decision:** Plaid (with Teller as fallback if Plaid coverage misses any of Michael's banks). No screen-scraping.
**Reason:** Plaid is the de-facto US bank-data API — broadest coverage, best DX, the only realistic path to live balances + transactions without bespoke per-bank work.

## 2026-05-10 — Accounting model: full double-entry from day one
**Decision:** Real chart-of-accounts + journal entries + ledger lines, not single-entry "totals on invoices." Every financial event posts paired debit/credit entries.
**Reason:** Per Michael's GPT plan, "invoice → JE → ledger" is the only model that survives the audit-trail, AR-aging, P&L, and AI-vendor-bill features he wants. Adding ledger later is harder than starting with it.

## 2026-05-10 — Audit log: dedicated table, mutation-source captured, no hard deletes for financial records
**Decision:** New `audit_logs` table (who, what, before, after, source, when). Mutations on invoices, bills, payments, journal entries write a row. Source values: `user`, `ai`, `stripe`, `plaid`, `system`. Financial records are voided/credited, never DELETE'd.
**Reason:** Trustworthy records require provenance. AI-generated entries especially must be flagged so a bookkeeper can audit them.

## 2026-05-10 — Hosting target: Vercel (when we eventually deploy)
**Decision:** When we move from local-only to hosted, deploy on Vercel — not Netlify, not Render, not Railway. Michael prefers Vercel.
**Reason:** Michael's preference. Practical fit too — Vercel's serverless model works fine for the Express app via their Node runtime, and they integrate cleanly with Supabase (Postgres) and Resend (transactional email) when those land.
**Implication:** When we add the hosted-DB swap (sql.js → Postgres via `pg`), structure the code so the DB module reads connection details from env (`DATABASE_URL`) rather than a hardcoded local file. We're already mostly there — just needs the swap module when the time comes.

## 2026-05-10 — Database: Supabase (Postgres) at deploy time
**Decision:** Production DB = Supabase Postgres. Dev/local stays on sql.js for zero-config development. The `db.js` wrapper exposes run/get/all/exec/transaction; we'll add a parallel Postgres implementation behind the same API when we deploy. Reads `DATABASE_URL` env var.
**Open question deferred:** Supabase Auth vs. our own session-based auth. Supabase Auth gives us magic links, OAuth, RLS for free; our session auth gives us full control but locks customers/workers/managers into one model. **Defer this decision to deploy day** — both work. For v0.6+ keep our own auth.
**Implication for now:** Schema is already SQLite-flavored but mostly Postgres-portable. Watch for: `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite) → `BIGSERIAL PRIMARY KEY` (Postgres), `datetime('now')` → `NOW()`, `strftime` (used in dashboard date math) → `to_char()`. Logged as v0.7 follow-up. Supabase Storage will host PDFs, logo, photo uploads.

## 2026-05-10 — Email transport: Resend at deploy time
**Decision:** Production email = Resend. Dev/local stays on file-drop (`mail-outbox/*.eml`).
**Reason:** Resend has the cleanest DX for transactional email, predictable deliverability, attachments work natively. Already future-proofed in `src/services/email.js` — set `EMAIL_MODE=smtp` + Resend's SMTP creds, or swap to their SDK with one require.
**Implication for now:** Nothing. The current email module switches transports on env var; no code change until deploy day.

## 2026-05-10 — Stack picture (decided)
**Production:** Vercel (host) + Supabase (Postgres + Storage + maybe Auth) + Resend (email) + Stripe (payments) + Plaid (bank balances) + AI APIs (extract).
**Dev / current:** Node 24 + Express + sql.js (in-memory + disk-persisted) + nodemailer (file-drop mode) + EJS + HTMX + Tailwind via CDN. Runs entirely on Michael's Windows machine.
**Migration plan:** db swap → email transport swap → Stripe wiring → Plaid wiring → AI extraction. Each is one focused session. None of them require rewriting the route layer.

## 2026-05-10 — reconprojectmanager repo: read-only reference, do NOT modify
**Decision:** Michael has an existing `mreoch1/reconprojectmanager` GitHub repo that's actively in use. We clone it to a sister folder ON THE LOCAL MACHINE for inspection only. We read from it to harvest structure / patterns / data models that should be ported into construction-app, but we do NOT:
- push to the upstream (origin)
- modify any file inside that working tree
- run scripts that mutate its database or files
The live repo stays untouched. All integration happens by copying patterns into construction-app/.
**Reason:** Michael's instruction: "I don't want to mess up Recon project manager it needs to stay active and unchanged."

## 2026-05-10 — Secrets policy: env vars only, never in code, never in git
**Decision:** All API keys, secrets, tokens (AI provider keys, Stripe live + restricted keys, Plaid client_id + secret, Resend API key, Supabase service role key, SESSION_SECRET in production) live exclusively in `construction-app/.env` on the local machine, and in Vercel's environment-variables UI when deployed. Code reads them via `process.env.<NAME>`. The `.env` file is already in `.gitignore`. A `.env.example` (committed) lists the required variable names with placeholder values, never real values.
**Reason:** Even a "test" key can leak through chat transcripts, log files, browser dev-tools recordings, screen-shares, and PR descriptions. Treating every key as production-sensitive is cheaper than discovering otherwise.
**Implication:** I (Claude) and Hermes never echo, paraphrase, write to a non-`.env` file, or commit any secret value. If a key is shared in chat, the action is: (1) acknowledge, (2) tell Michael to put it in `.env` himself, (3) recommend rotation if the chat is logged/persisted anywhere, (4) document the env var name for the eventual integration code. The actual secret string never enters our working files.
**TODO for Michael:** create `.env` (already gitignored), add `AI_API_KEY=...`, `AI_PROVIDER=...`. Rotate any key that's been pasted into chat as a precaution before production launch.

## 2026-05-10 — AI gating: extract-then-approve, never auto-post
**Decision:** AI vendor-invoice extraction lands in an `approval_queue` table with status='pending'. Human reviews + clicks Approve before any JE posts. AI suggestions visible in line-item form fields but not committed.
**Reason:** Per Michael's own rule: "do not let AI directly post accounting records without approval at first."

## 2026-05-10 — Bill JE: tax_amount as separate debit line (option C+)
**Decision:** Bills keep `tax_amount` for display honesty (PDF + show page show "Tax: $X.XX"). The journal entry posted on bill approval routes the tax to a dedicated expense account, code `5950 — Sales Tax — Vendor Bills`. So a bill with subtotal $325 + tax $24.50 posts as: DR Materials $325 + DR Sales Tax — Vendor Bills $24.50 / CR Accounts Payable $349.50. JE balances. Tax stays auditable.
**Reason:** Keeps the books balanced (which option-A "lump tax into total" doesn't without one of these tricks), preserves accurate per-account expense (which option-B "gross up each line" doesn't), and adds zero workflow friction. If Michael wants a use-tax-recovery flow later, the tax history is already separated by account.
**Implication:** `init-accounting.js` is now per-row idempotent (UPSERT-style: skip existing codes, insert missing ones) so an already-seeded DB will backfill 5950 automatically the next time `npm run init-accounting` runs.

## 2026-05-10 — AI items-library auto-maintenance (Round 9 work)
**Decision:** AI will help maintain the `items_library` table organically. After each estimate / WO / invoice save, an async pass compares each line item to the library:
- New description that's not in the library → suggest adding it (with the captured price + cost).
- Same description, different price → flag a price-drift suggestion ("Update library entry from $X to $Y?").
- Near-duplicate descriptions (e.g. "kitchen demo" vs "kitchen demolition") → suggest merging.

Suggestions land in a queue (reuses the `ai_extractions` table semantics or gets its own `library_suggestions` table). User reviews + approves before any library row is written or modified — same suggest-then-approve pattern as everything else.
**Reason:** Per Michael's request: "AI can help create reusable estimate items. If recurring descriptions come up with same pricing it should create / edit or modify existing items so they are always [current]."
**Implication:** Implementation lands in Round 9 after Round 8 (manual AI features + WO from free text) ships.

## 2026-05-10 — Bridge watcher: defer wakes during user keyboard activity (TODO patch)
**Issue:** Watcher's pyautogui injection types `check bridge` into whatever window is focused at the moment the wake fires. If Michael is typing in his Cowork chat box when Hermes replies, the wake message gets injected mid-word, garbling the user's input.
**Workaround for now:** Be aware of this. If a wake interrupts you, just delete the partial garble and continue.
**Patch (deferred to next bridge maintenance pass):** Use a global keyboard hook to detect recent user keypresses and defer the wake by 5-10 seconds when keystroke activity was detected within the last 2 seconds. `pynput.keyboard.Listener` gives us this on Windows. Trade-off: adds a dependency to the watcher.
**Status:** TODO — log noted, no action this session.

## 2026-05-10 — AI assistant role: helper, not authority
**Decision:** AI is an assistant layer that suggests and extracts — never the accounting authority. Pattern enforced everywhere: `AI Suggests → User Reviews → User Approves → System Posts`. AI never writes a journal entry directly. AI never edits an invoice or bill in place. AI output is always shown to the user as a draft suggestion they can accept, edit, or reject.

**MVP AI features (Round 8+, in priority order):**
1. **Tech-note cleanup** — paste raw field notes, AI returns cleaned invoice-ready descriptions. Save to WO line items only after user confirms.
2. **Invoice description generator** — given a WO line, AI rewrites the description in customer-friendly language. Replace-with-this-text button.
3. **WO → invoice line-item suggestions** — given a WO's lines, AI suggests which should transfer to the invoice and at what description. Same selected-checkbox pattern as estimates.
4. **Vendor receipt extraction** — upload PDF/image, AI extracts vendor / date / total / line items / suggested expense account. Lands in `ai_extractions` table as `pending`. User reviews on a queue page, edits, approves → creates a draft Bill.
5. **Expense category suggestion** — when manually entering a bill line, AI suggests which account based on description. Single-click accept.

**What AI does NOT do:**
- Post journal entries directly
- Send invoices to customers
- Mark anything as paid
- Modify locked records (sent invoices, approved bills, posted JEs)
- Run without an approver

**Audit:** Every AI call logged to `audit_logs` with `source='ai'` and the originating user. Token usage and cost tracked per call (Round 9 polish).

## 2026-05-10T15:30:00Z — Dashboard redesign shipped as parallel preview at /dashboard-v2
**Decision:** Built the today-focused schedule list redesign (Round 13) as a separate route `/dashboard-v2` and view `views/dashboard/v2.ejs` rather than replacing the current dashboard in place. Existing `/` dashboard still works untouched; the new design is reachable via a small "try new dashboard →" link on the classic page, and links back via "← classic dashboard".

**Reason:**
1. Hermes is mid-flight on Round 12 (mock data seeding). Replacing the dashboard while the seed script is being written would create merge friction.
2. The redesign needs real seeded data to evaluate visually. Leaving the old route intact lets Michael compare side-by-side once the seed lands.
3. If the redesign turns out wrong, reverting is `delete two files` — no rollback drama.
4. Once accepted, swap is a 3-line change in `dashboard.js` (rename handler).

**Design choices baked in (per Michael's confirmation message):**
- Today-focused vertical list, not horizontal calendar — avoids SaaS-template feel.
- Schedule = primary visual anchor (left column, ~62% width).
- Asymmetric grid (1.65fr / 1fr) — not symmetric cards.
- Action queues as compact bordered cards with count badges (right column).
- Activity stream as right-rail tertiary content.
- Bottom metrics strip (A/R, MTD, YTD, jobs, customers) — present but de-emphasized.
- Less border-radius (3-4px), thinner borders, monospace numbers, rule-line dividers instead of full card chrome.
- Status indicators: pulsing dot for in_progress (the only animation in the page), grey dot for scheduled.
- "Updated Xm ago" indicator with green dot — cosmetic only, no polling.

## 2026-05-10T15:35:00Z — Round 11 (global AI assistant) scoped in advance
**Decision:** Wrote a comprehensive scope doc at `ROUND_11_AI_ASSISTANT_SCOPE.md` covering capability tiers (Read → Navigate → Execute → Conflict-detect), tool-call set, suggest-then-confirm pattern, conflict-checking helper, audit trail, and worker/manager scoping. Doc not yet handed to Hermes — he's still on Round 12. Will turn into a directive after Round 12 verifies clean.

**Reason:** Round 11 is the next-largest piece after the seed lands. Pre-scoping it now means the directive can be a 30-min write rather than a 2-hour design + write when Michael is ready to kick it off.

## 2026-05-10T16:25:00Z — Dashboard v2 promoted to default, classic moved to /dashboard-classic
**Decision:** After Michael's positive review of dashboard-v2 ("dramatically better... actual operations software"), promoted v2 to be the canonical `/` route. Old KPI dashboard remains accessible at `/dashboard-classic` for reference and easy revert.

**Reason:** Michael said the redesign direction is "correct" and to "develop this out 100%." Keeping classic accessible is cheap insurance against finding a regression.

## 2026-05-10T16:30:00Z — Dashboard v2 visual iteration based on GPT-5.5 design notes
**Decision:** Iterated dashboard-v2 view with three concrete changes:
1. **Schedule rows multi-line, looser**: each row stacks WO# / customer (bold) / job desc (muted) / assignee — better human scanning rhythm. Time uses larger monospace with separated AM/PM suffix.
2. **Right rail collapsed from 4 cards to single flat queue**: "Overdue invoices · 3", "Estimates to send · 4", "Bills awaiting approval · 3", "Stale quotes · 2" — separated only by hairline rules, no card chrome. Single visual column rather than four boxed islands.
3. **Variable density across sections** (intentional irregularity): schedule rows ~0.9rem padding, action queue rows ~0.25rem, activity rows ~0.3rem with smaller font. Stronger heading hierarchy (h-primary 2px black underline, h-secondary 1px grey, h-tertiary uppercase eyebrow).

**Why:** Michael's feedback was "everything still has the same visual weight" and "too boxed". The flat rail with section dividers + variable density gives the page operational rhythm without adding component types.

## 2026-05-10T16:40:00Z — AI chat client widget shipped (Round 11 client side)
**Decision:** Built `public/js/ai-chat.js` as a vanilla-JS chat widget mounted via `src/views/layouts/footer.ejs` (only when authenticated). Floating bottom-right pill, expands to 380×500 panel. POSTs to `/ai/chat` (Hermes building server side). Handles 404 kill switch by hiding itself for the session. History in sessionStorage, capped at 20 messages. Pure progressive enhancement.

**Reason:** Hermes's strength is server-side implementation. By splitting the client side off to me, his Round 11 directive simplifies to tool registry + orchestrator + route handler. Client + server can develop in parallel and integrate via a documented JSON contract.

## 2026-05-10T16:55:00Z — WO show page redesigned to single-pane operational workspace
**Decision:** Edited `src/views/work-orders/show.ejs` in place with the same operational design tokens as dashboard-v2:
- Status strip with rule-line dividers (scheduled / assignee / progress / estimate / invoice / completed) — replaces the 3-card stat grid.
- Two-column main area: scope (left, wide) + customer/sub-WOs/documents (right).
- Custom checkbox visual for done/not-done items (green check if done, hollow square if not).
- Progress bar inline with the count (visual at-a-glance, no extra widget).
- Status dot in header (pulsing if in_progress, green if complete, grey if scheduled) — same vocabulary as dashboard.
- Notes feed with metadata-first layout (author + timestamp on top, body indented below).
- Customer block with phone/email/address as clickable lines (tel:, mailto:).
- Sub-WOs as a flat divider list, not a card-wrapped table.
- Danger zone styled with light red rule, only shown when allowed.

Also updated route handler to pass `notes` array (newest last, joined with users for author name) — wraps the table read in try/catch in case `wo_notes` is missing on older DBs.

**Reason:** Michael's stated page priority was "1. Dashboard first, 2. Then WO show page." With dashboard accepted, WO show is the next-most-trafficked page in operational use (workers hitting it during a shift). The same design language extends naturally — the strip pattern, status dot vocabulary, and rule-line section heads all reuse from the dashboard.

## 2026-05-10T17:55:00Z — Software named **FORGE**, published by Recon Enterprises (three-tier identity)
**Decision:** The application is named **FORGE** — acronym for **F**ield **O**perations, **R**ecords & **G**eneral **E**stimating. The publisher is **Recon Enterprises**. The default seeded operating company (i.e., the contractor running the system) is **Recon Enterprises**.

**Three-tier identity** — keep these separate when writing strings:
1. **Software brand** → `FORGE`. Used in nav header, footer, title tag, server boot log, README, package.json.
2. **Publisher** → `Recon Enterprises`. Used in "brought to you by" footer credit and any "powered by" attributions.
3. **Operating company** (seeded default in `company_settings.company_name`) → `Recon Enterprises`. This appears on customer-facing PDFs (estimate header, invoice header), email signatures, and customer-portal copy. It is editable per-deployment via `/admin/settings`.

**Rule for future code:** if the string is talking about the *software the user is using*, say "FORGE." If it's about the *company that built it*, say "Recon Enterprises." If it's about the *contractor sending the estimate*, pull from `company_settings.company_name` — do not hardcode.

**Implementation:**
- `src/views/layouts/header.ejs` — large "FORGE" wordmark, eyebrow "by Recon Enterprises".
- `src/views/layouts/footer.ejs` — "FORGE · Field operations, records & general estimating · brought to you by Recon Enterprises".
- `src/server.js` boot log — "FORGE server listening".
- `<title>` tag — "FORGE" / "Page title — FORGE".
- `.env.example` header — "FORGE — environment variables."
- PDF/email templates **continue** to read from `company_settings` (Recon Enterprises by default, customizable per install).

## 2026-05-10T17:00:00Z — Git commit collision while Hermes mid-flight on Round 11
**Decision:** Could not commit Round 13.x view changes from this side because Hermes left an `index.lock` orphan in `.git/`. The Linux mount lacks permission to remove it. Files are saved on disk. Will let Hermes pick them up in his Round 11 commit, or commit them after he wraps. Documented in DECISIONS in case the work appears uncommitted on review.
