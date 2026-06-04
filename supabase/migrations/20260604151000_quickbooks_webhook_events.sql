-- Inbound QuickBooks webhook notifications.
-- These are recorded separately from outbound sync logs so Forge can later
-- reconcile QuickBooks-side edits without losing the original event payload.

CREATE TABLE IF NOT EXISTS public.quickbooks_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  realm_id TEXT,
  entity_name TEXT,
  entity_id TEXT,
  operation TEXT,
  last_updated_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processed_status IN ('received','processed','ignored','failed')),
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qb_webhook_events_status
  ON public.quickbooks_webhook_events(processed_status, created_at);
CREATE INDEX IF NOT EXISTS idx_qb_webhook_events_entity
  ON public.quickbooks_webhook_events(entity_name, entity_id);

ALTER TABLE public.quickbooks_webhook_events ENABLE ROW LEVEL SECURITY;
