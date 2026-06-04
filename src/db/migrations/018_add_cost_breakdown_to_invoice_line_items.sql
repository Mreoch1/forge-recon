-- 018: Add labor/material/markup columns to invoice_line_items
-- Makes invoices match the estimate format with cost breakdown.

ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS labor_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS material_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS markup_pct NUMERIC(8,4) NOT NULL DEFAULT 25;
