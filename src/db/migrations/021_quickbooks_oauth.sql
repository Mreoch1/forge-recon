-- 021: QuickBooks OAuth tokens and sync integration

-- Store QuickBooks OAuth 2.0 tokens (only one active connection at a time)
CREATE TABLE IF NOT EXISTS quickbooks_tokens (
  id BIGSERIAL PRIMARY KEY,
  realm_id TEXT,                             -- QuickBooks company ID
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expires_at TIMESTAMPTZ NOT NULL,           -- when access_token expires
  refresh_token_expires_at TIMESTAMPTZ,      -- when refresh_token expires
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sync log: track what was imported and when
CREATE TABLE IF NOT EXISTS quickbooks_sync_log (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,                 -- Customer, Invoice, Bill, etc.
  action TEXT NOT NULL,                      -- pull, push, error
  summary TEXT,                              -- e.g. "Pulled 5 customers"
  details JSONB,                             -- error details or sync metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
