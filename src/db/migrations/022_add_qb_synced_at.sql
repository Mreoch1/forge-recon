-- 022: Add qb_synced_at to invoices for tracking QuickBooks sync status

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qb_synced_at TIMESTAMPTZ;
