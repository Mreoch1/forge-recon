-- 020: Add sent_to_email and sent_to_name columns to invoices table
-- These are written when an invoice is emailed via the send route.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_to_email TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_to_name TEXT;
