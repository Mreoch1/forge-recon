# QuickBooks Discovery

This document captures what we learned from Recon's QuickBooks exports on May 27, 2026. It is a working blueprint for customizing Forge around Recon's actual accounting data before any production import is attempted.

## Files Reviewed

- `RECON_ENTERPRISES.csv` — chart of accounts.
- `Customers (1).xls` — customer list.
- `Vendors.xls` — vendor list.
- `RECON ENTERPRISES_A_R Aging Summary Report.csv` — A/R aging as of May 27, 2026.
- `RECON ENTERPRISES_A_P Aging Summary Report.csv` — A/P aging as of May 27, 2026.
- `RECON ENTERPRISES_Balance Sheet.csv` — balance sheet as of May 27, 2026.
- `RECON ENTERPRISES_Profit and Loss.csv` — P&L for January 1-May 27, 2026.
- `Invoices.pdf` — QuickBooks invoice PDF export generated May 27, 2026.

## Current QuickBooks Scale

| Area | Count / Total |
| --- | ---: |
| Chart of accounts | 157 accounts |
| Customers | 1,070 records |
| Vendors | 262 records |
| A/R open lines | 153 lines |
| A/R total | $2,131,480.79 |
| A/P open lines | 31 lines |
| A/P total | $1,113,851.81 |
| Balance sheet assets | $2,637,208.05 |
| Balance sheet liabilities | $1,579,609.12 |
| Balance sheet equity | $1,057,598.93 |
| P&L income | $3,705,643.14 |
| P&L COGS | $2,278,157.23 |
| P&L gross profit | $1,427,485.91 |
| P&L expenses | $655,266.07 |
| P&L net income | $772,230.61 |
| Invoice PDF sample | 57 invoices / 60 PDF pages |
| Invoice PDF total | $785,556.01 |

## Chart of Accounts

Forge currently has placeholder accounting accounts. Recon's real chart needs to replace or map over the placeholder chart before any accounting import is trusted.

QuickBooks account type counts:

| QuickBooks account type | Count |
| --- | ---: |
| Expenses | 47 |
| Other Current Liabilities | 33 |
| Other Current Assets | 24 |
| Income | 16 |
| Equity | 10 |
| Other Expense | 9 |
| Cost of Goods Sold | 7 |
| Bank | 4 |
| Long Term Liabilities | 2 |
| Other Income | 2 |
| Accounts payable (A/P) | 1 |
| Accounts receivable (A/R) | 1 |
| Credit Card | 1 |

Important Recon revenue accounts:

- `4101 Sales Construction`
- `4102 Sales Painting`
- `4103 Sales Carpeting`
- `4104 Sales Subcontracting`
- `SALES RENT`
- `Maintenance Income`
- `Markup`
- `Billable Expense Income`

Important Recon cost accounts:

- `5101 C.O.G.S. Construction`
- `Warehouse Rent`
- `Lease Equipment`
- `Permits/Spec's/Plans`
- `Cost of Goods Sold`

Forge mapping requirements:

- Preserve QuickBooks account number, name, account type, and detail type.
- Add a `quickbooks_id` or external-source mapping later when API sync is added.
- Map QuickBooks account types into Forge's accounting types:
  - Bank, Accounts Receivable, Other Current Assets -> asset
  - Accounts Payable, Credit Card, Other Current Liabilities, Long Term Liabilities -> liability
  - Equity -> equity
  - Income, Other Income -> revenue or other income reporting group
  - Cost of Goods Sold, Expenses, Other Expense -> expense with report grouping.
- Keep QuickBooks display/report groups even if Forge's double-entry engine stores them in broader asset/liability/equity/revenue/expense types.

## Customers

Customer export columns:

- Name
- Company name
- Street Address
- City
- State
- Country
- Zip
- Phone
- Email
- Customer type
- Attachments
- Open balance

Customer data notes:

- 1,070 customer records.
- 181 customers have an open balance.
- Total customer open balance from the customer list was $2,227,886.29, which is higher than the A/R aging total of $2,131,480.79. Do not import customer-list open balances directly without reconciliation.
- Many customer records are incomplete:
  - 750 missing email.
  - 806 missing phone.
  - 708 missing usable address.
- Some customer names are really customer/project combinations, for example `Rose community builders/Plymouth Square`.

Forge mapping requirements:

- Import customer master records separately from open A/R.
- Normalize address fields before import; many rows have `US` or blank address pieces in the wrong columns.
- Preserve both `name` and `company_name`.
- Add import metadata so we can trace each record back to QuickBooks.
- Consider a customer/project split rule for names containing `/`, but do not auto-split without review because some names may be legal/customer names.

## Vendors

Vendor export columns:

- Vendor
- Company name
- Street Address
- City
- State
- Country
- Zip
- Phone
- Email
- 1099 Tracking
- Attachments
- Open Balance

Vendor data notes:

- 262 vendor records.
- 27 vendors have an open balance.
- Total vendor open balance: $1,113,851.81, matching A/P aging.
- Vendor data is cleaner than customer data, but still incomplete:
  - 190 missing email.
  - 106 missing phone.
  - 32 missing usable address.
- 1099 tracking exists in QuickBooks and should be supported in Forge.

Forge mapping requirements:

- Add vendor `quickbooks_name` or import metadata.
- Add 1099 tracking support.
- Import open balances through A/P aging or bill detail, not only the vendor list.
- Contractors and vendors may share a source list; Forge should avoid duplicated company records between `vendors` and `contractors`.

## A/R Aging

A/R as of May 27, 2026:

| Bucket | Amount |
| --- | ---: |
| Current | $1,207,851.37 |
| 1-30 | $711,351.01 |
| 31-60 | $29,370.00 |
| 61-90 | $11,170.00 |
| 91+ | $171,738.41 |
| Total | $2,131,480.79 |

Largest A/R balances:

- `Rose community builders/Plymouth Square` — $1,564,606.88.
- `Setter’s Point` — $283,200.00.
- `Crossroads Apartments` — $34,337.40.
- `Cambridge Towers Preservation LDHA, LLC` — $25,563.00.
- `Rose Community Builders/North Port` — $18,240.00.

Forge mapping requirements:

- Forge needs an opening A/R import process. The summary report is good for reconciliation, but invoice-level detail is still needed if Forge should track/send/collect individual invoices.
- A/R aging should reconcile to the balance sheet A/R account.
- The import should create either:
  - opening balance invoices per customer/project, or
  - imported historical invoices if detailed invoice exports are available.

## A/P Aging

A/P as of May 27, 2026:

| Bucket | Amount |
| --- | ---: |
| Current | $493,839.57 |
| 1-30 | $329,264.09 |
| 31-60 | $249,920.74 |
| 61-90 | $50,190.81 |
| 91+ | -$9,363.40 |
| Total | $1,113,851.81 |

Largest A/P balances:

- `D.W.G. Plumbing and Excavating, LLC` — $212,820.35.
- `Main Floor Covering` — $170,562.36.
- `Es Repair Pros` — $154,665.00.
- `Hard Rock Stone Works` — $148,535.94.
- `Ferguson Facilities Supply` — $144,897.49.

Forge mapping requirements:

- Forge needs an opening A/P import process.
- The summary report is enough for dashboard/report reconciliation, but bill-level detail is still needed to track bill numbers, due dates, projects, and work orders.
- Negative A/P balances must be supported. They may represent vendor credits, overpayments, or corrections.

## Balance Sheet

Balance sheet as of May 27, 2026:

- Assets: $2,637,208.05.
- A/R: $2,131,480.79.
- A/P: $1,113,851.81.
- Current liabilities: $1,579,609.12.
- Equity: $1,057,598.93.
- Net income: $772,230.61.
- The report balances: assets equal liabilities plus equity.

Forge mapping requirements:

- Imported opening balances must reconcile to this report before Forge accounting is trusted.
- Forge should show imported/opening balances as their own source, separate from transactions created natively in Forge.
- Balance sheet rendering must preserve QuickBooks-style report groups.

## Profit and Loss

P&L for January 1-May 27, 2026:

- Income: $3,705,643.14.
- COGS: $2,278,157.23.
- Gross profit: $1,427,485.91.
- Expenses: $655,266.07.
- Net operating income: $772,219.84.
- Other income: $10.77.
- Net income: $772,230.61.

Forge mapping requirements:

- Forge reports need true COGS grouping, not a generic expense list.
- Vendor bills should post to the proper cost or expense account.
- Invoices should post to the correct income account, usually construction-related revenue unless a specific service/item says otherwise.
- Project profitability should use the same revenue/COGS categories as P&L.

## Invoice PDF Export

The QuickBooks `Invoices.pdf` export contains 57 invoices across 60 PDF pages. Three pages are continuations of longer invoices. The export appears to be open invoices, because every invoice page shows `Overdue`.

Invoice export findings:

- Invoice dates range from January 1, 2026 through April 22, 2026.
- Parsed invoice total: $785,556.01.
- Invoice numbers are not always simple integers. QuickBooks includes values such as `14743.11`, `15011.9`, and `15170.6`.
- Terms vary by invoice, including `Net 30` and `Net 45`.
- Customer/job labeling is inconsistent but important:
  - Some invoices show a project/unit line above `Bill to`, for example `Peterboro Arms:703` or `Plymouth Square Apts:Unit 20241`.
  - Some invoices put the project/customer hierarchy inside the bill-to block, for example `Scott Anderson` plus `Rose community builders/Plymouth Square`.
  - Some customer addresses include weak placeholders such as `US`, so import cleanup must not assume address fields are reliable.
- Line items use QuickBooks `Product or service` separately from the customer-facing description.
- Many real line items use generic service/item names:
  - `**A` appeared 44 times.
  - `Services` appeared 7 times.
  - `20 Minute Fire Rated Door` appeared 7 times.
  - `Trash Chute Door/Frame` appeared 4 times.
  - `Tub Cut` appeared 4 times.
- Thirteen invoices have more than one line item. The longest parsed invoice has 9 line items.
- Retainage currently appears embedded in invoice descriptions on large progress invoices, not as a clean retained-balance field.
- QuickBooks appends a long `token=...` footer on each PDF page. Forge should not copy that footer into customer-facing PDFs unless a future QuickBooks link/share workflow requires it.

Forge invoice requirements from the PDF:

- Add external QuickBooks invoice number support separate from Forge's internal display number.
- Preserve decimal invoice numbers exactly as text.
- Add import metadata for original invoice number, PDF source, page span, original customer label, and original bill-to block.
- Support project/unit labels on invoices and PDFs, not only the bill-to customer.
- Support product/service or item mapping per line, but do not rely on product/service names alone for accounting because many lines are generic `**A`.
- Preserve multiline descriptions, bullets, quote marks, and manual markers such as `**Paint by Others**`.
- Add or map retainage explicitly before importing large progress invoices; otherwise retainage will be trapped inside description text.
- Treat this PDF as a discovery/sample export, not a full A/R import. It totals $785,556.01 versus the A/R aging total of $2,131,480.79.

## Recommended Import Order

1. Chart of accounts.
2. Customers.
3. Vendors / contractors.
4. Products and services / item list.
5. Open A/R detail.
6. Open A/P bill detail.
7. Active projects/jobs and work orders.
8. Historical invoices, bills, payments, and journal entries only after the open balances reconcile.

## Data We Still Need

To move from summary/reconciliation into a real import, we still need:

- Products and services list.
- Invoice list/detail export with invoice number, customer, date, due date, line items, account/item, total, balance, and status. The PDF export gives useful invoice structure, but not a reliable full import because it omits machine-readable IDs, balances, payment history, tax/account mappings, and may be only a subset of A/R.
- Bill list/detail export with vendor, bill number, bill date, due date, line items, account/item, project/customer, total, balance, and status.
- Payment detail for customer payments and vendor payments.
- Project/customer/job list if QuickBooks tracks projects separately.

## Guardrails

- Do not replace QuickBooks as the accounting source until Forge reconciles to QuickBooks for A/R, A/P, balance sheet, and P&L.
- Do not import summary aging rows as final invoice/bill records unless detailed exports are unavailable and Michael explicitly approves opening-balance records.
- Do not merge customers/vendors by loose name matching without review. Similar names may be different properties or legal entities.
- Preserve original QuickBooks values in import metadata so every imported Forge record can be audited back to its source row.
