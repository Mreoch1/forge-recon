# TASK_LOG

Completed work, newest-at-top. Each entry: TASK_ID, who shipped it, what the verification showed.

---

## F-001 — RFI multi-user assignment

- **Shipped:** 2026-05-20 — code by Hermes (commit `e24eccc`), migration applied by Cowork via Supabase MCP (`f001_decision_assignees`).
- **What landed:**
  - New table `decision_assignees(id, decision_id, user_id, assigned_at, assigned_by_user_id, notified_at)` with FK ON DELETE CASCADE on both sides + unique `(decision_id, user_id)`.
  - View `_decisions_log.ejs`: dropdown → checkbox multi-select; display now renders assignee chips.
  - Route `/projects/:id/decisions` (POST): accepts `assigned_to[]`, bulk-upserts to junction with `onConflict ignoreDuplicates`. Legacy `assigned_to_user_id` populated with first selection.
  - Route `/projects/:id` (GET): joins junction + users, exposes `d.assignees` array.
- **Cowork verification:**
  - Migration applied ✓ (table+indexes confirmed via `information_schema.columns`).
  - `node --check src/routes/jobs.js` passes.
  - Code review against brief acceptance criteria: 4/4 satisfied; the "edit-flow full replace" criterion was moot because the app has no decision-assignee edit route.

---

_(no earlier entries)_
