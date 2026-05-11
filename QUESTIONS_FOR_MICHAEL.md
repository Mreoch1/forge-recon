# Questions for Michael — answer when you have time

Running log of decisions where I made a temporary call but want your input when you're free. I won't stop the train waiting for these — they're queued, app keeps shipping. Reply in the chat any time and I'll adjust the codebase accordingly.

## Open

_(none currently)_

## Resolved / past decisions (for reference)

- **Single-tenant vs multi-tenant for v1** — Michael: single-tenant per deployment, multi-tenancy later.
- **Domain restriction on signup** — Michael: lock to `@reconenterprises.net`, admin email invites for outside users.
- **Stripe integration** — Michael: not needed for the business.
- **GitHub / Resend connectors** — Michael: don't have these connectors, work around them.
- **2-week view layout** — Hermes picked stacked over continuous 14-col, Michael approved.
- **Day view in calendar** — Michael: drop it, dashboard timeline covers today.
- **Drop redundant "Activity" rail on dashboard once timeline merge ships** — Michael: keep, repurpose as "Across all jobs" instead of deleting.
- **Round 20c drag-to-reschedule confirmation pattern** — direct UI inline confirm, NOT through AI chat confirm flow. Less wiring, faster UX.
