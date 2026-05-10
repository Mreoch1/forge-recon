# TODO for Michael

## v0.5 IN-PROGRESS — APP IS NOT RUNNABLE RIGHT NOW

Schema + routes have been rewritten for v0.5 (WO-as-root, sub-WOs, unified `0001-0000` numbering, billing_email, cost columns, payment_terms, scheduled date/time, manager+worker roles). Views haven't been rewritten yet.

**Do NOT run `npm run init-db` until views are finished.** It would wipe v0 data and the new schema doesn't match the old templates — every page would crash.

To continue: ask Claude to "finish v0.5 views" in the next session. Files needing rewrite:
- `src/views/work-orders/_form.ejs`, `new.ejs`, `edit.ejs`, `show.ejs`
- `src/views/estimates/_form.ejs`, `edit.ejs`, `show.ejs` (and remove `new.ejs` — estimates are now created via POST /work-orders/:id/create-estimate)
- `src/views/invoices/edit.ejs`, `show.ejs` (payment_terms select, cost column)
- `src/views/jobs/show.ejs` (show WOs and trace through to estimates/invoices)
- `src/routes/dashboard.js` + `src/views/dashboard/index.ejs` (activity feed UNION query references dead columns)
- `src/views/customers/show.ejs` (already mostly fine, just verify billing_email displayed)
- `src/views/admin/settings.ejs` (add `default_payment_terms`, drop separate prefix fields since unified numbering)

Once views are done, run: `rm data/app.db && npm run init-db && npm run seed && npm start`.



Things waiting on you in the morning. Each entry: what + why. Pick them off in any order.

## Critical (do before letting anyone else log in)

- [ ] **Rotate the seeded admin password.** Default is `admin@recon.local` / `changeme123`. Log in, go to Admin > Users > Edit > change password. Or change `seed.js` default and re-init the DB before any real use.

## Configuration

- [ ] **Fill in company settings.** Visit `/admin/settings`. Set: company name, address, phone, email, EIN, default tax rate, logo path. The seed has placeholders.
- [ ] **Wire real SMTP if/when you want emails to actually send.** `src/services/email.js` is configured to write `.eml` files to `mail-outbox/`. To switch to real SMTP, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` in `.env` and flip `EMAIL_MODE=smtp`. Until then, sent emails appear as files you can open in Outlook.

## Decisions to validate

- [ ] **Trade list.** I picked: general, electrical, plumbing, hvac, framing, drywall, paint, flooring, cabinetry, roofing, other. Edit the enum in `src/db/schema.sql` if you want different categories.
- [ ] **Number formats.** EST-YYYY-NNNN / WO-YYYY-NNNN / INV-YYYY-NNNN with annual reset. Change in `src/services/numbering.js` and `company_settings` if you want different.
- [ ] **Default tax rate.** Set to 0.0% on first run; change in /admin/settings.
- [ ] **Project folder location.** Currently inside the bridge folder. Move to `C:\Users\Mreoc\construction-app\` if you want cleaner separation — `git mv` and re-mount.

## Cosmetic / branding

- [ ] **Verify the recon logo.** Hermes will fetch it; I want you to eyeball that it's the right file on the login page and PDF header.
- [ ] **Email templates.** I'll seed neutral HTML templates for "estimate sent," "invoice sent," "invoice overdue." Read them, tweak voice.

## Nice to have (not blocking)

- [ ] **Customer self-service portal** — Phase 8. Customers log in, view estimates, accept/reject, view invoices, view payment status.
- [ ] **Pricing book / catalog** — recurring line items by trade, importable from CSV.
- [ ] **Mobile responsive polish** — works on phone, but I've optimized for desktop.
- [ ] **Reports** — A/R aging, jobs by status, revenue by trade, etc.
- [ ] **Audit log** — who edited what, when.

## v0.5 → Next session (accounting auto-posting)

- [ ] **Wire automatic JE creation.** `src/routes/accounting.js` and `src/db/init-accounting.js` exist as a skeleton. Next step: create journal entries automatically when invoices are sent (Dr A/R, Cr Revenue) and marked paid (Dr Cash, Cr A/R). Estimated effort: 1-2 hours.
- [ ] **Build chart of accounts CRUD.** Currently read-only via init-accounting.js seed. Add UI to add/edit/deactivate accounts.
- [ ] **Live reports.** Replace stub pages (trial-balance, profit-loss, balance-sheet) with real accounting queries computing running balances.
- [ ] **Manual journal entry form.** Allow creating manual JEs with debit/credit line validation (must balance).
- [ ] **Account reconciliation.** Upload bank statement, match against journal entries, flag unmatched.
