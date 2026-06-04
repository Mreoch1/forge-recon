-- 019: Add po_number to estimates and invoices for customer purchase order tracking

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_number TEXT;
