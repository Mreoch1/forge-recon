# Round 14 — Schedule + Activity Timeline Merge

Authored: 2026-05-10 (Claude, while Hermes builds Round 11)
Status: **Spec only — not yet a directive.** Held until Round 11 (AI chat) ships.

---

## What Michael asked for (his exact words)

> "Eventually: activity, schedule, status updates, completions should feel connected.
> Example:
> ```
> 8:00 AM  WO-0001  Mike started work
> 10:14 AM Photos uploaded
> 11:22 AM Customer approved change order
> ```
> This is where the app starts feeling **alive** instead of **database frontend**."

The dashboard's two left-column sections — **Today's schedule** + **Activity stream** — should merge into a single chronological timeline that reads like an event feed for the day. A WO appears at its scheduled time and any subsequent events (notes, photo uploads, status changes, customer interactions) interleave inline below.

---

## Mental model

This isn't "show schedule, show activity." It's **"the day, in order."** Each row is an event with a timestamp, a subject, and an actor. WO-scheduled rows are the spine; everything else clusters around them.

```
TODAY
─────────────────────────────────────────────────────
 8:00 AM    WO-0001  Cambridge Towers — Apt 3B
            ↳ Mike Kowalski assigned
 8:14 AM    WO-0001  Mike started work
 9:32 AM    WO-0001  3 photos uploaded
10:14 AM    WO-0001  Note: "Cabinets delivered, framing OK"

10:30 AM    WO-0002  O'Brien — Bathroom remodel
            ↳ Carlos Mendez assigned
11:22 AM    WO-0002  Customer approved change order ($+1,200)
12:50 PM    WO-0002  Mike marked 4 of 7 items complete

 1:00 PM    WO-0003  Whitaker — Storm damage roof
            ↳ Dave Thompson assigned
─────────────────────────────────────────────────────
SCHEDULED · 3:30 PM  WO-0004  TechSquare — Office TI
                              Tyrell Jones · 4 items
─────────────────────────────────────────────────────
```

Schedule rows that haven't happened yet appear at the bottom in a "scheduled" sub-section so the eye lands on what's already in motion.

---

## Event sources (what to merge)

For each WO scheduled today (or with activity today):
1. **WO scheduled** — the original anchor row (time = `scheduled_time`)
2. **Status changes** — from `audit_logs` where `entity_type='work_order'` and `event` includes 'started','completed','cancelled' (timestamp = audit `created_at`)
3. **wo_notes entries** — author + body
4. **wo_photos entries** — count + caption (Round 5 placeholder, may be empty)
5. **Estimate sent / accepted / rejected** — from `audit_logs` on the estimate
6. **Invoice sent / payment received** — from `audit_logs` on the invoice
7. **Line items completed** — from audit log when `completed` flips
8. **Sub-WO created** — when a child WO is added to this WO's tree
9. **Customer interactions** (Round 15+ when we have inbound email / SMS): "Customer replied to estimate"

Sort the union by timestamp ascending, group visually under the parent WO.

---

## Server work

### New service: `src/services/timeline.js`

```js
buildDayTimeline({ date, userId = null })
  → returns [
      {
        wo_id, display_number, customer_name, job_title,
        scheduled_time, assignee_name, status,
        events: [
          { type: 'scheduled', ts, label: 'Scheduled', actor: null },
          { type: 'assigned', ts, label: 'Assigned to Mike', actor: 'Mike' },
          { type: 'started', ts, label: 'Mike started work', actor: 'Mike' },
          { type: 'note', ts, label: 'Cabinets delivered, framing OK', actor: 'Mike' },
          { type: 'photos', ts, label: '3 photos uploaded', actor: 'Mike' },
          { type: 'item_done', ts, label: 'Marked 4 of 7 items complete', actor: 'Mike' },
          { type: 'estimate_sent', ts, label: 'Estimate sent', actor: 'system' },
          ...
        ]
      },
      ...
    ]
```

Order: WOs in chronological order of their first event (scheduled time or earliest activity).
For workers (role=worker), filter to WOs assigned to them.

### Dashboard route refactor

Replace the current `todayWOs` query + separate `activity` query with `buildDayTimeline({ date: today, userId: req.session.userId })`. Same for tomorrow's preview (smaller scope, just scheduled + assigned events).

### Dashboard view update

Replace the two left-column blocks (Today / Tomorrow) with a single timeline block. Each WO renders as:
- One **anchor row** (time + WO# + customer + job + assignee, like current schedule rows)
- **Indented sub-rows** for each event (smaller font, smaller dot, dotted left guide)
- A subtle visual gutter showing the WO's "thread"

Visual sketch:
```
┌─────────┬────────────────────────────────────────────┐
│ 8:00 AM │ ● WO-0001  Cambridge Towers                │
│         │ Kitchen renovation — Apt 3B                │
│         │ Mike Kowalski                              │
├─────────┼────────────────────────────────────────────┤
│  8:14   │  ↳ Mike started work                       │
│  9:32   │  ↳ 3 photos uploaded                       │
│ 10:14   │  ↳ "Cabinets delivered, framing OK" — Mike │
└─────────┴────────────────────────────────────────────┘
```

CSS: indented sub-rows have a vertical dotted-line on the left side of the time column, connecting all events for the same WO. Final event has the line stop.

---

## Activity stream → drop or repurpose

Once the timeline absorbs activity events, the right-rail "Activity" section becomes redundant for today's events. Options:
- **A**: drop it entirely (cleanest)
- **B**: repurpose as "recent across all days" — last 12 events globally, useful for managers seeing what's happening on jobs they're not directly working
- **C**: rename to "Across the company" — same as B but with a clearer label

Recommendation: **B with rename to "Activity (all jobs)"** — it adds value above the timeline (which is today-focused) without redundancy.

---

## Performance

The audit-log-driven timeline has more queries than the current dashboard. For a 4-WO day with 10-15 events each, that's 40-60 audit rows + 10-20 notes + 0-5 photos. All indexed on `entity_id` + `created_at`. Expected query time <50ms. Cache the timeline per (userId, date) for 60 seconds — invalidate on any audit-log write.

---

## Phasing

- **Phase 1**: Build the service. Replace the dashboard's left column with the timeline. Keep right rail (action queue + activity) as-is.
- **Phase 2**: Drop redundant activity stream from right rail (or reposition per option B above).
- **Phase 3**: Add same timeline to WO show page — every event for that single WO, ever.
- **Phase 4**: Live-tail mode (server-sent events) so notes added by other workers appear without refresh. Optional. Probably overkill for v1.

Ship Phase 1 first. Ship Phase 2 after Michael uses Phase 1 for a day.

---

## Smoke tests

1. Seeded data has notes on at least 3 of today's WOs — verify they appear under the right WO.
2. Mark a WO complete from another tab → reload dashboard → "Mike marked WO-XXXX complete" appears at the top of that WO's thread.
3. Add a note → reload → note appears with author + timestamp.
4. Worker login → only sees their own assigned WOs in the timeline.
5. Empty day (Sunday with no scheduled work) → graceful "No work scheduled. 0 events." state.
6. WO with no events besides "scheduled" → renders as a single anchor row, no indented children.

---

## Open question for Michael

Just one: do scheduled-but-not-yet-started WOs render in the same chronological flow (italicized / dimmed), or split out to a "Coming up later" subsection? My instinct is **same flow, dimmed** — preserves the timeline mental model. Confirm before building.

---
— Claude
