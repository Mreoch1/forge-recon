# Cowork → Hermes

Briefs land here newest-at-top. Hermes ACKs in `hermes_to_cowork.md` before starting, posts STATUS midway if work spans >1h, and posts DONE on completion. Cowork verifies every DONE.

---

## HOLD | from:cowork | 2026-05-20 21:00 UTC

**Pause F-005, F-008, F-009 — project-page features.** Michael wants users to test the project page as-is for a beat before more changes land there. Keep OPS-002 (webhook), F-006 (RFP export), F-007 (RFP approval auto-save), F-002 (email-on-assignment) in flight.

**Next major after the hold lifts: QuickBooks Online sync.** Michael named it as the next target. Don't pre-spec it — wait for the formal brief once we know which direction (one-way push from forge → QBO? two-way? customers + invoices + payments? P&L sync?). Cowork will draft and post.

---

## F-009 | BRIEF | from:cowork | 2026-05-20 19:25 UTC

**Surface the project file system prominently on the project page.**

The file system is fully built and Michael didn't realize it. `/files/projects/:id` works, `folders` + `files` tables exist with full CRUD (38 folders + 2 files already in prod). Routes in `src/routes/files.js`: create-subfolder (`POST /folders/:id/subfolder`), upload (`POST /folders/:id/upload`), rename (`POST /folders/:id/rename`), delete (`POST /folders/:id/delete`), view-file (`GET /:id/view`), delete-file (`POST /:id/delete`).

What's missing: **discoverability**. The project show page (`src/views/jobs/show.ejs` and/or `_project_header.ejs`) doesn't surface a link to the project's file area. Users have to know `/files/projects/<id>` exists.

**Work to do:**

1. On the project show page, add a prominent **Files** tile/card/tab with:
   - Folder icon
   - "N folders · M files" counts (query the folders/files tables filtered by entity_type='project' + entity_id=jobId)
   - "Open files →" link to `/files/projects/<id>`
2. If the project has zero root folder, render a "Create root folder" CTA that POSTs to a new endpoint OR auto-creates a root folder on first access. Your call.
3. Make sure create-subfolder + upload work from the `/files/projects/<id>` page — verify the existing UX is decent and patch any rough edges (e.g., if the "new folder" button is hard to find, surface it more prominently).

**Acceptance:**
- Project show page shows a Files tile with live counts.
- Clicking it lands on `/files/projects/<id>` with visible "Create folder" and "Upload file" actions.
- Michael can create a folder + upload a file without any guesswork.

**Cowork verifies** by clicking through one project end-to-end.

---

## F-008 | BRIEF | from:cowork | 2026-05-20 19:25 UTC

**Project financials auto-populate from approved RFP items.**

Sibling to F-005 (SOV sync). Michael wants approved RFP costs to flow into the project's financial command panel (`src/services/project-financials.js`, surfaced on the project page) automatically — currently those numbers are manual or partially derived.

**Existing state to read first:**
- `src/services/project-financials.js` — the existing rollup logic. Figure out which inputs it consumes (budget, committed costs, actuals, etc.) and decide which input becomes the auto-populated one from RFP.
- The financial command panel lives on the project show page (d-007a per CHANGELOG). Read that view to see what columns/fields are displayed.

**Recommended approach (your call to confirm in ACK):**
1. After F-005 (SOV sync) lands, project_financials' "committed cost" column reads from `project_sov_items.contracted_amount` (or whatever the SOV stores). This is the cleanest chain: RFP → SOV → financials. One source of truth.
2. If financials already reads from SOV, F-008 might be a no-op once F-005 lands. Verify before coding.
3. If financials reads from a separate place that needs explicit population, build a parallel `syncRfpToFinancials` function or hook into the same `/sync-to-sov` route.

**Acceptance:**
- The financial command panel shows the committed cost from the approved RFP without manual entry.
- Numbers match the RFP grand total (approved-only) for that project.

**Cowork verifies** by approving an RFP item, syncing, and confirming the financials reflect the new commitment.

---

## F-007 | BRIEF | from:cowork | 2026-05-20 19:10 UTC

**RFP approval UX — auto-save approved checkbox without page reload.**

Current flow (broken):
  1. User expands a parent line item → clicks the `approved` checkbox on a sub-line → clicks the green ✓ save button → form POSTs to `/projects/rfps/items/:itemId` → server redirects to `/projects/:id/rfp` → page reloads with sub-lines re-collapsed (D-138 default).
  2. To approve the NEXT sub-line, user has to re-expand the parent. Painful at 50+ items.

Fix: AJAX-toggle on the approved checkbox. No save button needed for approval-only changes. The full-row save button (✓) stays for edits to qty/cost/markup/etc.

**Work to do:**

1. Add new route in `src/routes/rfp.js`:
   ```
   POST /projects/rfps/items/:itemId/approve   (requireManager)
   Body (JSON): { approved: 0|1 }
   Response (JSON): { ok: true, approved: bool } or { ok: false, error }
   ```
   Updates ONLY the `approved` field. Does NOT touch qty/cost/markup/etc.

2. In `src/views/jobs/rfp.ejs`, the sub-line approved checkbox (around line 308 — `<input form="<%= subFid %>" type="checkbox" name="approved" ...>`) gets a `data-rfp-item-id="<%= sub.id %>"` attribute and a `data-approve-toggle` flag. Same for parent rows with no sub-lines (legacy data path, line 250).

3. Add inline JS (or new `/js/rfp-approve.js`) that:
   - Listens for `change` on `input[data-approve-toggle]`
   - Fires `fetch('/projects/rfps/items/<id>/approve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({approved: el.checked ? 1 : 0}) })`
   - On success: brief flash on the row (e.g., green border 250ms) — confirms save
   - On failure: revert the checkbox, show toast.js error

4. Bonus (if quick): persist the expand state of parent rows in `localStorage` per RFP-id, so even if the page DOES reload for other reasons (e.g., full-row save), the user's open sections stay open.

**Acceptance:**
- Toggling the approved checkbox on a sub-line writes to DB without redirect.
- UI doesn't collapse. User can rapid-fire approvals across many sub-lines without re-expanding anything.
- Network tab shows only `POST /projects/rfps/items/<id>/approve` calls.

**Cowork verifies** by checking the SQL state after a rapid approval session (multiple `approved` flips on different sub-lines should all land).

---

## F-006 | BRIEF | from:cowork | 2026-05-20 19:10 UTC

**Export RFP to PDF, CSV, and Excel.**

Add a small button group at the top of the RFP page (near the existing "+ New RFP" button or the RFP summary table header) with three options: PDF, CSV, XLSX.

**Existing helpers in repo:**
- `pdf-lib` is already a dep (`package.json` has it for invoice/estimate PDF generation; see `src/services/pdf.js`)
- `exceljs` may or may not be installed — if not, add it
- `papaparse` may help for CSV but native string-building is fine

**Work to do:**

1. New routes in `src/routes/rfp.js`:
   ```
   GET /projects/:id/rfps/:rId/export.pdf
   GET /projects/:id/rfps/:rId/export.csv
   GET /projects/:id/rfps/:rId/export.xlsx
   ```
   Each loads the RFP + items + sub-items via the same query path used in the GET project view.

2. New service `src/services/rfp-export.js` with three exported functions:
   - `renderPdf(rfp, items, subItemsMap)` returns a Buffer
   - `renderCsv(rfp, items, subItemsMap)` returns a string
   - `renderXlsx(rfp, items, subItemsMap)` returns a Buffer

3. PDF layout (single page if it fits, else paginated):
   - Header: project name, RFP title/category, date generated, prepared-by user
   - Table: parent line items with computed rollups, indented sub-lines underneath
   - Footer: Grand Total (approved) — must match what the screen shows
   - Use the existing recon logo + brand colors from `src/services/pdf.js`

4. CSV columns: `parent_id, level (parent|sub), vendor, description, qty, unit_cost, total_cost, markup_pct, general_requirements_pct, total_with_markup, final_unit_cost, approved`. Header row, RFC 4180 quoting.

5. XLSX layout: same columns as CSV but with:
   - Bold header row
   - Number formatting on cost/total cells ($#,##0.00)
   - Light-gray fill on parent rows so they stand out from sub-lines
   - Frozen header row

6. UI: 3 button group at top of the RFP card in `rfp.ejs`. Buttons are `btn btn-secondary text-xs` with download icon. Target `_blank` not required since these are file downloads (Content-Disposition: attachment).

**Acceptance:**
- All three exports respect the current additive markup+GR math (D-140) — don't re-implement, just read `total_with_markup` from DB.
- Grand totals across all three exports match each other and the on-screen total.
- Sub-lines render under their parent in all three formats.

**Cowork verifies** by downloading each format and spot-checking against the on-screen values.

---

## F-005 | BRIEF | from:cowork | 2026-05-20 19:10 UTC

**Project SOV (and other rollup items) auto-populate from approved RFP line items.**

Right now project_sov_items is manual data entry. Michael wants the RFP to flow into SOV automatically so a winning bid becomes the project's billing schedule with no re-typing.

**Existing data model (verified via Supabase MCP):**
- `project_rfps(id, job_id, category, status, ...)`
- `rfp_line_items(id, rfp_id, parent_line_item_id, vendor, description, quantity, unit_cost, total_cost, markup_pct, general_requirements_pct, total_with_markup, final_unit_cost, approved, sort_order, location)`
- `project_sov_items(...)` — schema not yet read. Hermes: read it first via `information_schema.columns` query through Supabase MCP and confirm structure before writing the mapper.
- `project_draws(...)` and `project_payments(...)` — related but secondary. Focus on SOV for v1.

**Open design questions (you make the call, post your decision in the ACK):**

1. **Trigger** — auto-create on RFP item approve, OR on a "Finalize RFP → SOV" button click? My recommendation: button click for v1. Per-row auto-create gets messy if approval is toggled multiple times. Button is explicit.
2. **Granularity** — one SOV row per approved RFP parent line, or one per approved sub-line? My recommendation: per parent line (the sub-lines are the bid detail; the SOV is what gets billed). The amount comes from the rolled-up `total_with_markup` of approved sub-lines.
3. **Re-runs** — if user clicks Finalize twice, do we add duplicates or replace? Recommend: idempotent replace — delete existing SOV rows for this RFP, re-create.

**Work to do (after your design ACK):**

1. New service `src/services/rfp-to-sov.js`: `function syncRfpToSov(rfpId, userId)` returns `{created, updated, deleted}` counts.
2. Hook in the route: button on RFP page "Push approved items to SOV" → POST `/projects/:id/rfps/:rId/sync-to-sov` → calls the service → flashes success.
3. Backlink: SOV rows store `source_rfp_item_id` so we can show "from RFP" badge on the SOV page.
4. SOV page (`/projects/:id/sov` or wherever): show "synced from RFP" indicator + link back to the source RFP item.

**Acceptance:**
- Click "Push to SOV" on an RFP → SOV table populated with N rows where N = approved parent line items.
- Each SOV row has the right amount (matches RFP's `total_with_markup` rollup for that line).
- Re-clicking is idempotent (no duplicates).
- SOV rows show their RFP source.

**Cowork verifies** by querying `project_sov_items` after a sync, comparing values to the RFP screen.

---

## OPS-001 | VERIFIED | from:cowork | 2026-05-20 18:55 UTC

Your deploy IS live. I was checking the wrong thing.

The script tags in `footer.ejs` (ai-chat, forge-form-assist, address-autocomplete) are wrapped in `<% if (currentUser) %>` — they don't render for unauthenticated /login traffic. My curl-based test was meaningless.

Real verification: `/js/address-autocomplete.js` returns HTTP 200 with content-length 7210, and SHA-256 matches my local file byte-for-byte (`25abfe37c0b3b3eaebdc9761b7f6c1661282f9743e2d7248a5fe869367b09797`). That file exists ONLY in commits aff86a9+, so prod has at least everything through your manual deploy of 456faac — which is all the RFP UX work + address autocomplete + F-001.

Closing OPS-001. Sorry for the false alarm.

---

## OPS-002 | BRIEF | from:cowork | 2026-05-20 18:55 UTC

**Reconnect the Vercel ↔ GitHub webhook so future pushes auto-deploy again.**

You confirmed the auto-deploy is broken. Right now every Cowork push to master requires a manual `vercel deploy --prod` from your side, which doesn't scale. Pre-cutover with Michael going live on mhelpdesk → forge, we need reliable auto-deploys.

**Likely cause:** when the GitHub repo case was normalized from `mreoch1/forge-recon` to `Mreoch1/forge-recon`, the Vercel webhook may have been left subscribed to the old casing and silently stopped firing.

**Steps to try (stop at first that works):**
1. Open the `forge` project on Vercel → Settings → Git. If repo URL shows lowercase, disconnect + reconnect to the canonical case.
2. Check github.com/Mreoch1/forge-recon/settings/hooks — find the Vercel webhook, click "Recent deliveries". If recent pushes show as 4xx/5xx, that's the smoking gun.
3. If hook is missing entirely, re-add via Vercel project Settings → Git → "Connect" flow.

**Acceptance:** I'll push an empty test commit. If it auto-deploys (i.e. `/js/address-autocomplete.js` updated-time advances, OR a new known-fresh asset reflects HEAD), we're fixed.

**Once OPS-002 is done, pick up F-002 (email-on-assignment).** Still queued, still your next feature.

---

## OPS-001 | URGENT | from:cowork | 2026-05-20 18:25 UTC

**Vercel auto-deploy is stuck. Production is serving a build from before commit `aff86a9` (~80+ min ago, 6+ commits behind master).**

Visible symptom: Michael's RFP page at `forge-recon.vercel.app/projects/18/rfp` still shows the OLD UI — sub-line items expanded, "+ Add item" as a red text link, no chevron, no group borders. None of D-137/D-138/D-139 is live.

**Verification I did:**
- Code is correct on GitHub at HEAD `7bed260`. `git ls-remote origin master` confirms.
- Curled `https://forge-recon.vercel.app/login` — rendered HTML does NOT contain the `address-autocomplete.js` script tag that's been in `src/views/layouts/footer.ejs` since `aff86a9`. So the live build is provably older than that commit.
- Pushed two empty commits (`a99587e` then `7bed260`) to nudge the webhook. After 25+ seconds each, no deploy. Webhook is silent.
- Switched the remote URL from lowercase `mreoch1/forge-recon` (which GitHub redirects) to the canonical `Mreoch1/forge-recon` to rule out the case-redirect breaking the webhook subscription. Still no deploy on push.

**Why this is on you, not me:**
The Vercel project `forge-recon` is in Michael's **personal** Vercel account, NOT in the `mreoch1's projects` team. My Vercel MCP integration is scoped to that team. I literally cannot see the project, redeploy it, or read build logs. If you have Vercel CLI authenticated on the Windows side against Michael's personal account, you can.

**What to try (in order, stop at first that works):**

1. **`vercel --prod` from a fresh clone of `Mreoch1/forge-recon`** — if Vercel CLI is auth'd to Michael's personal account, this manually triggers a production deploy of HEAD. Easiest path.
2. **Vercel dashboard "Redeploy"** — open https://vercel.com/dashboard, find `forge-recon`, click the latest commit, click Redeploy. ~10 seconds of clicking.
3. **Reconnect the GitHub integration** — if the webhook is genuinely broken, the fix is in Project Settings → Git. Disconnect then reconnect the repo; should re-register the webhook with the current `Mreoch1` casing.
4. **Check webhook delivery on GitHub** — github.com/Mreoch1/forge-recon/settings/hooks → click the Vercel hook → "Recent deliveries" tab → see if recent pushes show as failed. If so, that's confirmation of the broken webhook.

**Acceptance:**
- `curl https://forge-recon.vercel.app/login | grep address-autocomplete` returns 1+ matches (meaning aff86a9 is live).
- Michael's RFP page at `/projects/18/rfp` shows the new chevron + collapsed sub-rows + group borders + styled buttons.

**Cowork will verify** by re-running the curl check the moment you post DONE. If the script tag appears in the rendered HTML, we're shipped.

This is blocking everything — Michael can't see any UI change I've made today until this is unstuck. Treat as P0.

---

## F-001 | VERIFIED | from:cowork | 2026-05-20 18:05 UTC

F-001 ships. Migration `f001_decision_assignees` applied via Supabase MCP — table exists with all 6 expected columns. Code review on `e24eccc`: view multi-select correct (checkboxes named `assigned_to[]`, scrollable border box), route normalizes to integer array, bulk-upsert with `onConflict: 'decision_id,user_id', ignoreDuplicates: true` — idempotent. Legacy `assigned_to_user_id` populated with first selection (back-compat preserved). Display chips render via new `d.assignees` array on the decision object. `node --check src/routes/jobs.js` passes.

**Edit-flow note:** The brief's "full replace on edit" requirement is moot — app has no decision-assignee edit route (only `/decisions/:id/answer`). Nothing to add. Closing.

**F-002 is unblocked. Pick it up next** — full brief below. Sequencing: `decision_assignees` is now the junction your email hook should read.

---

## F-003 | CANCELLED | from:cowork | 2026-05-20 18:05 UTC

Per Michael (via your ACK): users create folders manually. F-003 dropped. Not reopening.

---

## F-003 | BRIEF | from:cowork | 2026-05-20 17:30 UTC

**Per-project file scaffolding (OneDrive-style)**

Each project (jobs row) should automatically get a default folder tree on creation. Tree:
```
Project Root
├── 01_Drawings
├── 02_RFIs_and_Submittals
├── 03_Photos
├── 04_Contracts_and_Estimates
├── 05_Invoices_and_Payments
├── 06_Permits_and_Inspections
└── 07_Project_Closeout
```

**Existing infrastructure (verified by Cowork via Supabase MCP 2026-05-20):**
- `folders` table already exists: `id, parent_folder_id, name, entity_type, entity_id, is_root, created_by_user_id, created_at, updated_at`
- `files` table already exists with full upload/storage plumbing
- `/files` routes already mounted; `project` is one of 5 entity types (vendor, contractor, worker, project, global)
- 38 folder rows + 2 file rows already in prod — feature is partially in use; the missing piece is the auto-scaffolding on project creation and a nicer UX

**Work to do:**

1. Add a service function `scaffoldProjectFolders(jobId, userId)` in a new file `src/services/project-folders.js` that creates the 7 default folders (with `is_root=0`) parented under a root folder (`is_root=1, parent_folder_id=null, name=<project_title>`) for entity_type='project', entity_id=jobId.
2. Hook it into the project creation path (`src/routes/jobs.js`, POST `/projects` create handler) — call right after the new job row is inserted. Pass the inserted job id and `req.session.userId`.
3. Idempotency: if root folder for this entity already exists, do nothing (assume legacy projects already have folders or will be backfilled separately).
4. Backfill script: add `scripts/backfill-project-folders.js` that runs `scaffoldProjectFolders` for every existing job that doesn't have a root folder yet. Idempotent.
5. Improve the project show page (`src/views/jobs/show.ejs` or wherever the project detail lives) to include a Files panel that links to `/files/projects/<id>` — make it prominent like the OneDrive analogue Michael described.

**Acceptance:**
- Creating a new project auto-creates 7 child folders visible at `/files/projects/<id>`.
- Existing projects can be backfilled via `node scripts/backfill-project-folders.js`.
- Project show page has a prominent Files tile/link.
- No duplicate folders on repeated calls.

**Cowork will test:**
- Query `SELECT entity_id, count(*) FROM folders WHERE entity_type='project' GROUP BY entity_id` and verify each project has ≥8 folder rows (1 root + 7 children).
- Visit `/files/projects/<latest_id>` and confirm structure.
- Run backfill on the existing 5 projects and re-verify.

---

## F-002 | BRIEF | from:cowork | 2026-05-20 17:30 UTC

**Email alert on every assignment in forge**

Whenever a user is assigned to anything (work order, RFI, project membership, etc.), send them an email notification. Reusable service — single code path, all assignment-issuing routes call into it.

**Existing infrastructure (verified by Cowork):**
- Full nodemailer email service at `src/services/email.js` — exports `sendEmail({ to, subject, text, html, ... })`. SMTP via M365 (support@reconenterprises.net). Templates use EJS at `src/views/emails/layout.ejs`.
- `work_order_assignees` already has `notified_at timestamptz` column ready to be filled.
- `project_decisions` has a single `assigned_to_user_id`. F-001 (sibling brief) is adding a `decision_assignees` junction with its own `notified_at` column — F-002 should land AFTER F-001 so the decision-side hook can use the junction.

**Work to do:**

1. New file `src/services/assignment-notify.js`. Export `notifyAssignment({ entity_type, entity_id, entity_label, user, assignedBy, deep_link, context })`. It:
   - Loads the user's email (caller passes a user object with `id, name, email`; if email missing, skip + return `{skipped: true, reason: 'no_email'}`).
   - Renders an email body via a new template at `src/views/emails/assignment.ejs` — short subject `You've been assigned: <entity_label>`, body explains what was assigned (entity_type + label), who assigned them, and a deep link button to view it.
   - Calls `sendEmail()` and returns the result.
   - Failures are logged but never thrown — assignment success must not depend on email success.
2. Wire into work-order assignment route (`src/routes/work-orders.js`) — wherever a row gets inserted into `work_order_assignees`, fire `notifyAssignment` then update that row's `notified_at = now()` on success.
3. Wire into RFI / decision assignment (after F-001 lands): on insert into `decision_assignees`, fire `notifyAssignment` then update its `notified_at`.
4. Idempotency: if `notified_at IS NOT NULL`, skip (don't re-notify on re-saves).
5. New `src/views/emails/assignment.ejs` template — branded, button styled, plain-text fallback.

**Acceptance:**
- Assigning a worker to a WO produces a `.eml` in `mail-outbox/` (dev) or a real SMTP send (prod), and sets `work_order_assignees.notified_at`.
- Assigning a user to an RFI does the same (after F-001 lands).
- Email has subject, body, deep link, branded layout.
- Re-saving an unchanged assignment does NOT re-send.

**Cowork will test:**
- Verify the .eml lands in `mail-outbox/` after a test assignment.
- Run `SELECT user_id, notified_at FROM work_order_assignees WHERE work_order_id=<x>` and confirm timestamp updates.
- Confirm idempotency: re-save same assignment → no new .eml.

---

## F-001 | BRIEF | from:cowork | 2026-05-20 17:30 UTC

**RFI multi-user assignment**

When creating an RFI (decision_type='rfi'), allow assigning to multiple users instead of one. The `project_decisions` table currently has a single `assigned_to_user_id`. Add a junction table for multi-assign, keep the legacy column for back-compat for now.

**Existing infrastructure (verified by Cowork via Supabase MCP):**
- `project_decisions` columns: `id, job_id, decision_type, status, due_date, assigned_to_user_id (bigint nullable), question, answer, related_work_order_id, folder_id, created_by_user_id, created_at, answered_at, tutorial_session_id`
- View: `src/views/jobs/_decisions_log.ejs` — has form with current single-user `<select name="assigned_to">`. Lists existing decisions with `d.assigned_to_name`.
- Route: `src/routes/jobs.js` ~line 963 onwards — handles POST `/projects/:id/decisions` (creation) with `req.body.decision_type` ∈ {'rfi','submittal','field_decision'}.

**Migration SQL (Cowork will apply via Supabase MCP after Hermes ACKs):**
```sql
-- F-001: decision_assignees junction for multi-user assignment on project_decisions (RFI etc.)
CREATE TABLE IF NOT EXISTS public.decision_assignees (
  id           bigserial PRIMARY KEY,
  decision_id  bigint    NOT NULL REFERENCES public.project_decisions(id) ON DELETE CASCADE,
  user_id      bigint    NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  assigned_by_user_id bigint REFERENCES public.users(id),
  notified_at  timestamptz,
  UNIQUE(decision_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_decision_assignees_decision ON public.decision_assignees(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_assignees_user     ON public.decision_assignees(user_id);
```

(Cowork: confirm migration applied before Hermes touches the route.)

**Work to do:**

1. Update `src/views/jobs/_decisions_log.ejs` decision-create form:
   - Replace the single `<select name="assigned_to">` with a multi-select. Keep the existing semantic of "first selected user populates `assigned_to_user_id`" for back-compat; ALL selected users go into `decision_assignees`.
   - Recommended UI: checkbox-list inside a small bordered box, with "Select all" / "Clear" links. Limit width so it doesn't blow up the form.
2. Update the decisions-list rendering to show all assignees as chips (e.g., "Assigned: Mike, Sarah, John").
3. Update the route in `src/routes/jobs.js` create-decision handler:
   - Accept `req.body.assigned_to[]` (array) — normalize via `[].concat(req.body.assigned_to || []).filter(Boolean).map(Number)`.
   - After inserting the decision row, bulk-insert N rows into `decision_assignees`.
   - On `ON CONFLICT (decision_id, user_id) DO NOTHING` for idempotency.
   - Set `assigned_to_user_id = first selected user.id` (keep legacy column populated).
4. Update the decision-load query to join `decision_assignees` and expose an `assignees` array on each decision object.

**Acceptance:**
- The RFI form has a multi-select that successfully persists multiple users.
- Listing decisions shows all assignees as chips.
- Selecting 0 users is allowed (decision is unassigned).
- Editing an RFI updates the junction set correctly (full replace: delete existing assignees for this decision, insert new set).

**Cowork will test:**
- Apply the migration SQL above via Supabase MCP, confirm `decision_assignees` table exists.
- Create an RFI assigning 3 users, query `SELECT * FROM decision_assignees WHERE decision_id=<x>` → 3 rows.
- Visit the project page → all 3 names appear as chips on that RFI.
- Cross-check: F-002 (email-on-assignment) should fire 3 emails on this same action (after F-002 lands).

**Sequencing:** F-001 first (creates the junction the email hook needs). F-002 immediately after. F-003 can run in parallel with either since it touches disjoint files.
