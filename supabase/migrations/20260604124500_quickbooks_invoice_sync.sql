-- QuickBooks Online invoice sync foundation.
-- Forge remains the working system; QuickBooks IDs are stored for idempotent
-- invoice pushes and later reconciliation.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS quickbooks_id TEXT,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS quickbooks_synced_at TIMESTAMPTZ;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS quickbooks_id TEXT,
  ADD COLUMN IF NOT EXISTS quickbooks_doc_number TEXT,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_status TEXT NOT NULL DEFAULT 'not_synced'
    CHECK (quickbooks_sync_status IN ('not_synced','pending','synced','failed')),
  ADD COLUMN IF NOT EXISTS quickbooks_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS quickbooks_realm_id TEXT,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_payload JSONB;

CREATE TABLE IF NOT EXISTS public.quickbooks_connections (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  realm_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT DEFAULT 'bearer',
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  connected_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quickbooks_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('customer','invoice')),
  entity_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  quickbooks_id TEXT,
  message TEXT,
  request_json JSONB,
  response_json JSONB,
  user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_quickbooks_id ON public.customers(quickbooks_id);
CREATE INDEX IF NOT EXISTS idx_invoices_quickbooks_id ON public.invoices(quickbooks_id);
CREATE INDEX IF NOT EXISTS idx_invoices_qb_sync_status ON public.invoices(quickbooks_sync_status);
CREATE INDEX IF NOT EXISTS idx_qb_sync_logs_entity ON public.quickbooks_sync_logs(entity_type, entity_id);

ALTER TABLE public.quickbooks_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quickbooks_sync_logs ENABLE ROW LEVEL SECURITY;
