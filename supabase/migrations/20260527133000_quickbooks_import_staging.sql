-- QuickBooks import staging.
-- These tables are intentionally separate from live Forge records. Imports land
-- here first for review/reconciliation before anything is applied.

CREATE TABLE IF NOT EXISTS public.quickbooks_import_batches (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'chart_of_accounts',
    'customers',
    'vendors',
    'products_services',
    'invoices',
    'bills',
    'payments',
    'ar_aging',
    'ap_aging',
    'balance_sheet',
    'profit_loss',
    'other'
  )),
  original_filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN (
    'staged',
    'reviewed',
    'applied',
    'void'
  )),
  row_count INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2),
  imported_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quickbooks_import_rows (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES public.quickbooks_import_batches(id) ON DELETE CASCADE,
  row_type TEXT NOT NULL,
  external_id TEXT,
  external_number TEXT,
  display_name TEXT,
  record_date DATE,
  due_date DATE,
  amount NUMERIC(14,2),
  balance NUMERIC(14,2),
  status TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  matched_entity_type TEXT CHECK (matched_entity_type IS NULL OR matched_entity_type IN (
    'account',
    'customer',
    'vendor',
    'contractor',
    'project',
    'work_order',
    'estimate',
    'invoice',
    'bill',
    'payment'
  )),
  matched_entity_id BIGINT,
  review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (review_status IN (
    'needs_review',
    'ready',
    'applied',
    'ignored'
  )),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qb_import_batches_source ON public.quickbooks_import_batches(source_type);
CREATE INDEX IF NOT EXISTS idx_qb_import_batches_status ON public.quickbooks_import_batches(status);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_batch ON public.quickbooks_import_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_type ON public.quickbooks_import_rows(row_type);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_review ON public.quickbooks_import_rows(review_status);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_external_number ON public.quickbooks_import_rows(external_number);
