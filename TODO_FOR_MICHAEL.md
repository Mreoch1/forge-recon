# TODO for Michael

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
