-- Migration 007: Add invoice billing_complete status.
-- Used after the invoice has been sent and synced/closed in QuickBooks.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft','sent','paid','billing_complete','overdue','void'));
