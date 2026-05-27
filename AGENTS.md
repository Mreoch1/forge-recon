## Project Rules

Download repo `mreoch1/forge-recon`.

### Layout consistency

- New operational/list/report pages must use the shared Forge page shells instead of ad hoc Tailwind width wrappers.
- Use `ops-shell` for operational dashboards, lists, rollups, project/RFP/file pages, and wide report tables.
- Use `document-shell` for read-only detail/document pages such as work orders, estimates, invoices, bills, vendors, contractors, and compact accounting reports.
- Use `document-edit-shell` for estimate/invoice/work-order edit screens that need wide line-item tables.
- Narrow `max-w-* mx-auto px-4 py-6` wrappers are acceptable only for focused forms, admin settings, and single-column flows where wider layout would hurt readability.
- Before adding or redesigning a page, compare it to the current Forge list/detail/report pages and keep header spacing, action placement, cards, tables, and back links consistent.

