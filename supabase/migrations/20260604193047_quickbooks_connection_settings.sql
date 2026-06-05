ALTER TABLE public.quickbooks_connections
  ADD COLUMN IF NOT EXISTS default_item_id TEXT,
  ADD COLUMN IF NOT EXISTS default_item_name TEXT,
  ADD COLUMN IF NOT EXISTS default_income_account_id TEXT,
  ADD COLUMN IF NOT EXISTS default_income_account_name TEXT,
  ADD COLUMN IF NOT EXISTS settings_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_qb_connections_realm
  ON public.quickbooks_connections(realm_id);
