# FORGE Runbook

For whoever is on call when production misbehaves. Read top to bottom the first time, then use as a reference.

![placeholder: Vercel dashboard with the forge-recon project highlighted]

## Where things live

- **Production**: https://forge-recon.vercel.app
- **Vercel dashboard**: https://vercel.com (look for the `forge-recon` project) — deploys, env vars, runtime logs.
- **Supabase dashboard**: https://app.supabase.com — DB tables, SQL editor, migrations, storage.
- **Email (current)**: Microsoft 365 SMTP via `support@reconenterprises.net`. Configured in env as `SMTP_*` vars consumed by `src/services/email.js`.
- **Email (deprecated)**: Resend was the previous provider. We are no longer on Resend — any references in older docs are stale.

## Pulling Vercel logs

The fast way:

```bash
vercel logs forge-recon --json --no-follow
```

For human-readable output:

```bash
vercel logs forge-recon --expand --no-follow
```

Heads up: on **Windows MSYS2 / Git Bash**, the Vercel CLI's interactive follow mode hangs because the TTY detection is wrong. Always pass `--json` or `--expand` (and `--no-follow`) when running from MSYS2. From PowerShell or a real Linux shell, the default works fine.

## Common 500 root causes from this round

Three live-fire bugs we hit recently, in case they come back:

1. **`trust proxy` missing** — Express was not configured to trust Vercel's proxy, so the session cookie's `secure` flag plus a non-HTTPS view of `req.protocol` meant cookies were never emitted. Symptom: login appears to succeed, then every subsequent request bounces back to `/login`. Fixed in r30f by adding `app.set('trust proxy', 1)`.
2. **EJS template comment with embedded `%>`** — an email template had a comment whose body contained `%>`, which EJS parsed weirdly, threw at render time, and the surrounding `try/catch` swallowed the failure. Symptom: email "sends" with no error, customer never gets it. Fixed in r30c by stripping the broken comment.
3. **Service still using old `db` module after the R32 Supabase SDK refactor** — one require still pointed at the old SQLite-style wrapper, and Node crashed at import time on cold boot. Symptom: function returns a 500 with no log line because it died before logging was wired. Grep for `require('../db/db')` in any new service; everything should be on `require('../db/supabase')`.

## Schema migrations

Use the Supabase MCP tool `apply_migration` — Cowork has it wired up. Pass it a name and SQL, and it runs against the linked project. Migrations are also stored under `supabase/migrations/` in the repo. Never run schema changes manually in the SQL editor — they won't be tracked.

## Rolling back a deploy

From any machine with the Vercel CLI signed in:

```bash
vercel rollback
```

Pick the previous good deployment from the list. Alternatively, **promote** the previous deployment from the Vercel dashboard. Rollback is instant — DNS and routing flip immediately.

## M365 SMTP gotchas

If outgoing email stops working:

- **SMTP AUTH must be enabled per mailbox**. M365 disables it by default. Run this in Exchange Online PowerShell against the sending mailbox:

  ```powershell
  Set-CASMailbox -Identity support@reconenterprises.net -SmtpClientAuthenticationDisabled $false
  ```

- **App password required if MFA is enabled** on the mailbox. Create one in the M365 security portal and put it in `SMTP_PASS`. A regular password will fail with a 535 auth error.
- Host is `smtp.office365.com`, port 587, STARTTLS.

## Where to find data

| What | Where |
|------|-------|
| Customer records | Supabase `customers` table |
| Work orders | Supabase `work_orders` table (plus `work_order_line_items`, `wo_notes`, `wo_photos`) |
| Estimates / invoices / bills | `estimates`, `invoices`, `bills` |
| Audit trail | `audit_logs` (also viewable in-app at `/admin/audit`) |
| WO photos (binaries) | Supabase Storage, bucket `wo-photos` |
| Company-wide settings | `company_settings` (single row, id = 1) |

## Owner email hardcode

`mike@reconenterprises.net` is always treated as admin, regardless of the DB `role` column. This is enforced in `src/middleware/auth.js` via the `OWNER_EMAILS` env var (defaults to that address). It is belt-and-suspenders — even if someone fat-fingers the owner's role to `worker`, the owner still gets admin access. To add more permanent owners, set `OWNER_EMAILS` to a comma-separated list in Vercel env vars and redeploy.
