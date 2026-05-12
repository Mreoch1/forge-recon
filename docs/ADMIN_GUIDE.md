# FORGE Admin Guide

This guide is for the tenant admin. You manage users, company settings, shop closures, and you have access to AI usage and audit logs.

You reach the admin pages from `/admin` once you're signed in as an admin user.

![placeholder: Admin landing page with links to Users, Settings, Closures, AI Usage, Audit]

## Adding users

Go to `/admin/users` and click **+ New user**.

Fill in:

- **Name** — full name; this is what shows on assignments, notes, and audit entries.
- **Email** — used for sign-in and password resets. Must be unique.
- **Role** — pick one:
  - **admin** — full access, including this admin area.
  - **manager** — office staff. Can create customers, jobs, WOs, estimates, invoices, bills.
  - **worker** — field crew. Can only see and update WOs assigned to them.
- **Password** — at least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol.
- **Active** — leave on. Toggle off to disable an account without deleting it.

You cannot demote or deactivate the last active admin, and you cannot demote yourself while signed in. There is one hard-coded owner email (set in env as `OWNER_EMAILS`) that is always admin no matter what the DB role says.

## Resetting a user's password

Open the user from `/admin/users` and click **Edit**. There is a separate **Reset password** form on the edit page. Type the new password twice and submit. The password rules are the same as on user creation. The user is not emailed automatically — share the new password securely.

## Company settings

`/admin/settings` controls company-wide defaults:

- **Company name**, **address**, **phone**, **email**, **EIN** — printed on estimate and invoice PDFs.
- **Default tax rate** — pre-fills new estimates and invoices. Stored as a percentage.
- **Default payment terms** — one of Due on receipt, Net 15, Net 30, Net 45, Net 60, or Custom.
- **Next WO main number** — the next root work order number FORGE will hand out. Change this if you need to skip ahead or reserve a block of numbers.

## Closures (shop holidays)

`/admin/closures` is where you add holidays, shutdowns, and company events. Each closure has a name, start date, optional end date (for multi-day), a type (Holiday / Closure / Company event), and optional notes.

Closures show up as shaded bands on the **Schedule** page so dispatchers don't accidentally book work on days the shop is closed.

## AI usage tracking

`/admin/ai-usage` shows how much the AI assistant features are being used. You'll see:

- Total AI calls and total tokens used (with a rough cost estimate)
- A 14-day usage chart
- Top 5 users by call count
- The 20 most recent calls with the user, message snippet, token count, and latency

This is informational — there are no controls here, just monitoring.

## Audit log review

`/admin/audit` lists recent activity, newest first, 50 entries per page. Every meaningful change (create / update / status transition / note added / login / password reset / etc.) writes an audit row.

You can filter by **entity type** (work_order, invoice, user, etc.) and **action**. Each row shows the user, timestamp, entity, action, and the before/after JSON for changes. Use this when you need to know who did what, when.
