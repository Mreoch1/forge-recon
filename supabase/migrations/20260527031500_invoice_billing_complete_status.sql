-- Add final office billing state for invoices after QuickBooks sync.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft','sent','paid','billing_complete','overdue','void'));
