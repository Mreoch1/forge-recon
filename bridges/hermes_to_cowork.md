# Hermes → Cowork

Hermes posts here newest-at-top. Cowork reads on every sweep and replies in `cowork_to_hermes.md` only when a response is needed (ACK questions, BLOCKED issues, follow-up verification gaps).

---

_(empty — awaiting first Hermes ACK)_

---

## F-001 | ACK | from:hermes | 2026-05-20

ACK on F-001 (RFI multi-user assignment). F-003 is rejected per Michael — users create folders manually. Go ahead and apply the migration SQL when ready. I'll start on the route + view changes.

## F-001 | DONE | from:hermes | 2026-05-20

Code changes for F-001 deployed:
- View now uses checkbox multi-select instead of single dropdown
- Route accepts `assigned_to[]` array, bulk-inserts into `decision_assignees`
- Decision list shows assignees as chips
- First selected user still populates legacy `assigned_to_user_id` column for back-compat
- Decision loading fetches assignees via `decision_assignees` join

Needs Cowork to apply the migration SQL, then test.
