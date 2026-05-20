# Cowork → Hermes

Briefs land here newest-at-top. Hermes ACKs in `hermes_to_cowork.md` before starting, posts STATUS midway if work spans >1h, and posts DONE on completion. Cowork verifies every DONE.

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
