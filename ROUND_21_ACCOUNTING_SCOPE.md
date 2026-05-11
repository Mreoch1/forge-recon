# Round 21 — Accounting Buildout

Authored: 2026-05-10 (Claude session, while Hermes builds Round 19)
Status: **Spec only.** Will become a directive after Round 19 + Round 20 land.

---

## What Michael asked for

> "you still have to build out the accounting side of this."

Current state: solid backbone (chart of accounts, JE + lines, audit log, auto-JE on invoice/bill events, trial balance, P&L, balance sheet). Missing: the operational accounting features that make this more than a balanced-books backend. Below is what I judge most important based on contractor-business workflow.

---

## Five priorities (in order)

### 1. Manual journal entries

Right now every JE is auto-posted from invoice/bill events. There's no UI to enter an adjusting JE — vehicle depreciation, owner draws, opening balances, year-end accruals, fix-a-mistake reversals. Critical for any real bookkeeping.

**Build:**
- `GET /accounting/journal/new` → form with: date, description (memo), reference number (optional), and a dynamic table of journal lines (account dropdown + debit + credit + line memo).
- Form validates: at least 2 lines, sum(debits) === sum(credits), each line has either a debit or a credit (not both, not zero).
- `POST /accounting/journal` → INSERT journal_entry + journal_lines, audit log entry.
- `GET /accounting/journal` → list view of all manual JEs with filters: date range, account, source.
- `GET /accounting/journal/:id` → show view, with "Reverse this entry" button (creates a mirrored JE with reversed amounts and "Reversal of JE-XXX" memo).
- Permission: admin only (or admin + manager — your call). Workers never see this.

### 2. AR aging report

The "who owes us money and how late" view.

**Build:**
- `GET /accounting/aging/ar` → report grouped by customer with columns:
  - Current (not yet due)
  - 1-30 days past due
  - 31-60 days past due
  - 61-90 days past due
  - 90+ days past due
  - Total outstanding
- Each row links to the customer's invoice list filtered to outstanding.
- Pull from `invoices` WHERE `status IN ('sent','overdue')`. Bucket by `due_date` vs `today`.
- Footer row with column totals.
- Export-as-CSV button (small route returns CSV).

### 3. AP aging report (mirror of AR)

The "who do we owe and how late" view.

**Build:**
- `GET /accounting/aging/ap` → grouped by vendor.
- Same buckets, same shape.
- Pull from `bills` WHERE `status IN ('approved')` (not yet paid). Bucket by `due_date`.

### 4. Customer statements

A document showing a customer's running balance — what they were billed, what they paid, what's outstanding. The thing you mail/email when chasing payment.

**Build:**
- `GET /customers/:id/statement` → renders an HTML statement showing date range filter (default last 90 days), every invoice issued, every payment received, running balance, current outstanding total.
- `GET /customers/:id/statement.pdf` → PDF download (use existing pdfkit setup from Round 3B).
- "Email statement" button → uses the same shared estimate-email pattern, but for statements.
- Permission: manager + admin.

### 5. Sales tax remittance tracking

Most US contractors collect sales tax on materials sold and have to remit it to the state quarterly or monthly. Right now we calculate `tax_amount` per invoice but there's no view summarizing "you collected $X in sales tax this quarter, time to file."

**Build:**
- `GET /accounting/sales-tax` → quarterly view (default current quarter):
  - Total taxable sales
  - Total non-taxable sales (commercial cap-improvement exempt invoices)
  - Total sales tax collected
  - Tax rate breakdown (if multi-rate — single rate for v1)
  - Comparison vs previous quarter
- "Mark as remitted" button records a remittance (new table: `tax_remittances` with date, period, amount, journal_entry_id) and posts a JE: debit `Sales Tax Payable`, credit `Cash`.
- Pull from `invoices` filtered to status ∈ {sent, paid} where `tax_amount > 0`. Bucket by sent/paid date.

---

## Schema additions

```sql
CREATE TABLE IF NOT EXISTS tax_remittances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start TEXT NOT NULL,        -- YYYY-MM-DD
  period_end TEXT NOT NULL,          -- YYYY-MM-DD
  amount REAL NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id)
);
```

That's the only new table. Manual JEs reuse existing journal_entries + journal_lines tables.

---

## Nav + IA

Update the Accounting nav dropdown (or sub-page) to include:
- Trial Balance (existing)
- P&L (existing)
- Balance Sheet (existing)
- AR Aging (new)
- AP Aging (new)
- Sales Tax (new)
- Manual Journal (new)

Statements live under each customer's profile, not global.

---

## Smoke tests

1. Manual JE: open form, enter $500 debit on Vehicle Expense, $500 credit on Cash, save → trial balance still balanced, JE appears in journal list, audit log has entry.
2. Reverse a manual JE → mirror entry created, original marked as reversed (visual indicator), trial balance still balanced.
3. AR aging: with 2x mock data, see customers grouped, totals match `SELECT SUM(total - amount_paid) FROM invoices WHERE status IN ('sent','overdue')`.
4. AR aging CSV export → downloads a parseable CSV.
5. AP aging: similar smoke against bills.
6. Customer statement HTML view: shows last 90d activity, running balance correct.
7. Customer statement PDF: opens, formatted cleanly.
8. Sales tax remittance: shows current quarter total, marking as remitted creates a JE that zeroes out Sales Tax Payable.
9. Worker login → none of these pages accessible (manager+ only).
10. Audit log shows source='user' for all manual JEs.

---

## Out of scope this round

- Bank reconciliation (heavier feature — Plaid integration is the right answer here, not manual rec)
- 1099 tracking (could phase in once we have a vendor with TIN field)
- Cash flow statement (P&L is enough for v1)
- Budget vs actual (would need a budgets table; post-launch)
- Multi-currency
- Period close / locking (would mean preventing edits to JEs in a closed period; post-launch)
- Payroll (he uses 1099 contractors, not W-2)

---

## Estimated effort

- Manual JE form + routes + validation: ~2 hours
- AR aging + AP aging (mirror pattern): ~2 hours
- Customer statement HTML + PDF: ~2 hours
- Sales tax view + remittance JE: ~1.5 hours
- Smoke + cleanup: ~30 min

**Total: ~8 hours of focused Hermes work. Could split into two directives if it feels too dense.**

---
— Claude
