# Round 20 — Schedule Calendar View

Authored: 2026-05-10 (Claude session, while Hermes builds Round 19)
Status: **Spec only — not yet a directive.** Will become msg 35 to Hermes after Round 19 lands clean.

---

## What Michael asked for

> "I still don't have my schedule calendar view that autopopulates from data entered into WO's."

A calendar UI — week and month grids — that pulls every WO's `scheduled_date` + `scheduled_time` automatically and renders them as time blocks. No manual data entry into a separate calendar; the WO IS the source of truth.

This is the operational view that lets a manager look at next week and decide "Mike's slammed Tuesday, move WO-1043 to Wednesday." Today's dashboard timeline shows just today + tomorrow preview. The calendar is the multi-day strategic view.

---

## Three views, one route

`GET /schedule` — defaults to current week.

Query params:
- `view=day | week | month` (default `week`)
- `date=YYYY-MM-DD` (default today; for week view, snaps to that week's Monday; for month, snaps to that month's first)
- `assignee=<user_id>` (optional filter — show only one tech's schedule)

Three layouts share a header strip and a body that swaps based on `view`:

### Day view
- Single column, hourly rows from 6 AM to 8 PM.
- WOs render as time blocks anchored at `scheduled_time`, sized to a default duration (4 hours, configurable via env).
- Click a WO block → navigates to `/work-orders/:id`.
- Empty hours show a thin rule line, not blank space — keeps the timeline rhythm.

### Week view (default)
- 7-column grid, Mon–Sun, with a left gutter of hour labels (6 AM – 8 PM in 1h rows).
- Each WO is a card in its column at its scheduled time, colored by assignee (deterministic hash → palette).
- Multi-assignee column: when more than one WO overlaps for the same person on the same day, stack horizontally as 50% / 33% width slices.
- Today's column subtly highlighted (background tint, not border).
- The current time has a horizontal "now" line across all columns (red, 1px, with a small dot at the left gutter).

### Month view
- 6-row × 7-column grid (standard month layout).
- Each cell shows up to 3 WOs as compact pills (just `WO-XXXX-XXXX` + assignee initial). If more than 3, a "+N more" link expands the day to a popover or navigates to that day's day-view.
- Cells outside the current month are dimmed.
- Today's cell has a subtle red rule on top.

---

## Page chrome (consistent with FORGE design language)

- Header strip: `← May 2026` button, view toggle (Day / Week / Month), assignee filter dropdown, "+ New WO" button, "Today" button (jumps back to current).
- Two-column or one-column? **One column** — the calendar IS the content. No sidebars. Maximize horizontal space.
- Below the calendar: a footer summary showing counts ("16 WOs scheduled this week · 4 unassigned · 2 conflicts").

---

## Conflicts highlighted

Reuse `findScheduleConflicts` from Round 17. For each WO rendered, if it overlaps another WO on the same assignee:
- Add a small "⚠" badge in the corner of the block
- Hovering shows the conflict details
- The footer summary's "2 conflicts" link scrolls to the first one

---

## Drag-to-reschedule (Phase 2)

Phase 1 (this round): static rendering, click-through to WO show.
Phase 2 (deferred — Round 20.5 or after deploy): drag a WO block to a new time slot → triggers the existing `reschedule_wo` mutation flow with a confirmation card. No raw DB write — every drag is a proposed mutation.

Don't build Phase 2 in Round 20. Set it up so the data attributes on each block (`data-wo-id`, `data-current-date`, `data-current-time`) are present, so Phase 2 just needs the JS layer.

---

## Data fetching

Single query per view: pull WOs in the date window with the join we already use (customer + assignee + status).

Day: `WHERE date(scheduled_date) = ?`
Week: `WHERE date(scheduled_date) BETWEEN ? AND ?` (Monday → Sunday)
Month: `WHERE date(scheduled_date) BETWEEN ? AND ?` (first → last of the month, including overflow days from prior/next month for the 6-row grid)

Index on `scheduled_date` already exists. No performance concerns at our data volume.

---

## Color palette for assignees

Hash the user's `id` to a fixed palette of 8 colors that contrast against white and have enough variation between teammates. Avoid recon-red (reserved for action / urgent). Suggested: cool blue, warm yellow-green, lavender, teal, coral, mint, slate, peach.

`function colorForUser(userId) { return PALETTE[userId % PALETTE.length]; }`

Unassigned WOs (`assigned_to_user_id` IS NULL): rendered as light-grey blocks with diagonal hatching. Visually distinct from assigned work.

---

## Responsive behavior

- Desktop: full grid as designed
- Tablet (≤900px): week view collapses to 3 days at a time with prev/next chevrons
- Phone (≤600px): defaults to day view, with prev/next buttons to scroll days. Month view becomes a list of dates with WO count per day. Week view hidden behind a "switch to day" hint.

---

## Nav

Add `<a href="/schedule">Schedule</a>` to the main nav between Dashboard and Customers. Active state when on `/schedule*`.

---

## Smoke tests

1. `/schedule` → defaults to current week → shows seeded mock WOs in the right time slots.
2. Toggle to Day view → shows just today's 8 WOs (with 2x mock data) stacked in time order.
3. Toggle to Month view → shows full month with WO counts per day.
4. Click a WO block → goes to `/work-orders/:id`.
5. Filter by assignee → only that user's WOs render.
6. WO with conflict → "⚠" badge, hover tooltip with conflict details.
7. "Today" button → jumps current view back to today's window.
8. Phone-width viewport → Day view default, prev/next works.
9. Unassigned WO → grey hatched block.
10. Empty week (jump to a week with no WOs) → "No work scheduled" message instead of bare grid.
11. Month view, day with 5+ WOs → shows "3 visible + 2 more" link, click expands.
12. Schedule page renders with seeded 2x mock — no JS errors.

---

## Out of scope this round

- Drag-to-reschedule (Phase 2)
- iCal/Google Calendar export
- Worker self-view of own schedule (workers should see Day view filtered to themselves; that's just default behavior + worker scoping)
- Notification on conflict
- Sub-WO grouping in the calendar (each sub-WO renders as its own block; sibling pairing is post-launch)

---

## Estimated effort

- Backend route + queries: ~1 hour
- View/CSS for 3 layouts: ~3 hours
- Conflict highlighting (reuse Round 17 helper): ~30 min
- Responsive breakpoints: ~1 hour
- Nav + smoke: ~30 min

**Total: ~6 hours of focused Hermes work, batched as one directive.**

---
— Claude
