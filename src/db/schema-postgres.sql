-- FORGE — Postgres schema (Round 22 deploy migration)
--
-- Translation of the SQLite schema (schema.sql + schema-accounting.sql) for use
-- against Supabase Postgres. Key conversions:
--
--   * INTEGER PRIMARY KEY AUTOINCREMENT  →  BIGSERIAL PRIMARY KEY
--   * REAL                               →  NUMERIC(14,2)   (money — exact precision)
--   * REAL (non-money: quantity, etc.)   →  NUMERIC(12,4)
--   * TEXT created_at DEFAULT datetime() →  TIMESTAMPTZ DEFAULT now()
--   * TEXT scheduled_date / due_date     →  DATE
--   * TEXT scheduled_time                →  TIME (or kept as TEXT for HH:MM flexibility — kept TEXT)
--   * INTEGER 0/1 boolean fields         →  BOOLEAN
--   * CHECK constraints                  →  same syntax (Postgres-native)
--   * ON DELETE CASCADE                  →  same
--   * PRAGMA foreign_keys                →  not needed (PG enforces by default)
--
-- Code-side changes Hermes must make in db.js for the cutover (separate task):
--   * Replace sql.js bindings with `pg` driver
--   * Convert `?` placeholders → `$1, $2, ...`
--   * Use `RETURNING id` on INSERTs to get new row id
--   * Cast NUMERIC to Number() in JS-land for arithmetic
--   * Use proper Date objects instead of string parsing for scheduled_date / due_date

-- ========== TUTORIAL SESSIONS ==========
CREATE TABLE IF NOT EXISTS tutorial_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  state_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== USERS ==========
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','manager','worker')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  phone TEXT,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token TEXT UNIQUE,
  verification_expires_at TIMESTAMPTZ,
  completed_onboarding_at TIMESTAMPTZ,
  acknowledged_live_email_warning_at TIMESTAMPTZ,
  default_landing TEXT DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== CUSTOMERS ==========
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  billing_email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  quickbooks_id TEXT,
  quickbooks_sync_error TEXT,
  quickbooks_synced_at TIMESTAMPTZ,
  notes TEXT,
  tutorial_session_id UUID REFERENCES tutorial_sessions(id),
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== JOBS ==========
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK(status IN ('lead','estimating','scheduled','in_progress','complete','cancelled')),
  scheduled_date DATE,
  scheduled_time TEXT,            -- HH:MM, kept as TEXT for null-friendliness
  assigned_to_user_id BIGINT REFERENCES users(id),
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_members (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('superintendent','pre_construction','accountant','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, user_id)
);

-- ========== WORK ORDERS ==========
CREATE TABLE IF NOT EXISTS work_orders (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  parent_wo_id BIGINT REFERENCES work_orders(id),
  wo_number_main INTEGER NOT NULL,
  wo_number_sub INTEGER NOT NULL DEFAULT 0,
  display_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','in_progress','complete','cancelled')),
  scheduled_date DATE,
  scheduled_time TEXT,
  completed_date DATE,
  assigned_to_user_id BIGINT REFERENCES users(id),
  assigned_to TEXT,
  notes TEXT,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_order_line_items (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ========== ESTIMATES ==========
CREATE TABLE IF NOT EXISTS estimates (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL UNIQUE REFERENCES work_orders(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('new','draft','sent','pending','approved','accepted','rejected','expired')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(8,4) NOT NULL DEFAULT 0,    -- e.g. 6.2500 = 6.25%
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_terms TEXT NOT NULL DEFAULT 'Net 30',
  valid_until DATE,
  notes TEXT,
  po_number TEXT,
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS estimate_line_items (
  id BIGSERIAL PRIMARY KEY,
  estimate_id BIGINT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_bill_id BIGINT,
  source_bill_line_id BIGINT
);

-- ========== INVOICES ==========
CREATE TABLE IF NOT EXISTS invoices (
  id BIGSERIAL PRIMARY KEY,
  estimate_id BIGINT NOT NULL UNIQUE REFERENCES estimates(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','sent','paid','billing_complete','overdue','void')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_terms TEXT NOT NULL DEFAULT 'Net 30',
  due_date DATE,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  sent_to_email TEXT,
  sent_to_name TEXT,
  notes TEXT,
  po_number TEXT,
  qb_synced_at TIMESTAMPTZ,
  conditions TEXT,
  quickbooks_id TEXT,
  quickbooks_doc_number TEXT,
  quickbooks_sync_status TEXT NOT NULL DEFAULT 'not_synced'
    CHECK (quickbooks_sync_status IN ('not_synced','pending','synced','failed')),
  quickbooks_synced_at TIMESTAMPTZ,
  quickbooks_sync_error TEXT,
  quickbooks_realm_id TEXT,
  quickbooks_sync_payload JSONB,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  material_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  markup_pct NUMERIC(8,4) NOT NULL DEFAULT 25,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_bill_id BIGINT,
  source_bill_line_id BIGINT
);

-- ========== COMPANY SETTINGS ==========
CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  company_name TEXT NOT NULL DEFAULT 'Recon Enterprises',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  ein TEXT DEFAULT '',
  default_tax_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  default_bill_markup_pct NUMERIC(8,4) NOT NULL DEFAULT 25,
  default_payment_terms TEXT NOT NULL DEFAULT 'Net 30',
  next_wo_main_number INTEGER NOT NULL DEFAULT 1,
  logo_path TEXT NOT NULL DEFAULT '/logos/recon.png',
  current_year INTEGER NOT NULL DEFAULT 2026
);

-- ========== WO NOTES + PHOTOS ==========
CREATE TABLE IF NOT EXISTS wo_notes (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wo_photos (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id),
  filename TEXT NOT NULL,         -- storage key under wo-photos bucket
  original_filename TEXT,          -- user's original filename
  mime_type TEXT,                  -- MIME type for non-image files
  size_bytes BIGINT,               -- file size in bytes
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== ITEMS LIBRARY ==========
CREATE TABLE IF NOT EXISTS items_library (
  id BIGSERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  category TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== ACCOUNTING ==========
CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  parent_account_id BIGINT REFERENCES accounts(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT,
  source_id BIGINT,
  created_by_user_id BIGINT REFERENCES users(id),
  reversed_by_entry_id BIGINT REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id BIGSERIAL PRIMARY KEY,
  journal_entry_id BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  debit NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  description TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vendors (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  ein TEXT,
  default_expense_account_id BIGINT REFERENCES accounts(id),
  notes TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bills (
  id BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT NOT NULL REFERENCES vendors(id),
  bill_number TEXT,
  job_id BIGINT REFERENCES jobs(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','approved','paid','void')),
  bill_date DATE,
  due_date DATE,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by_user_id BIGINT REFERENCES users(id),
  approved_by_user_id BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bill_lines (
  id BIGSERIAL PRIMARY KEY,
  bill_id BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_extractions (
  id BIGSERIAL PRIMARY KEY,
  source_filename TEXT NOT NULL,
  extracted_json JSONB NOT NULL,        -- promote to JSONB for native query/index
  vendor_match_id BIGINT REFERENCES vendors(id),
  suggested_account_id BIGINT REFERENCES accounts(id),
  confidence NUMERIC(5,4),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','superseded')),
  approved_by_user_id BIGINT REFERENCES users(id),
  resulting_bill_id BIGINT REFERENCES bills(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  metadata JSONB,
  source TEXT NOT NULL DEFAULT 'user'
    CHECK(source IN ('user','ai','stripe','plaid','system')),
  user_id BIGINT REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  tool TEXT NOT NULL,
  args JSONB NOT NULL,
  summary TEXT NOT NULL,
  warnings JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','confirmed','cancelled','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== QUICKBOOKS IMPORT STAGING ==========
-- Staged imports stay separate from live Forge records until reviewed.
CREATE TABLE IF NOT EXISTS quickbooks_import_batches (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'chart_of_accounts',
    'customers',
    'vendors',
    'products_services',
    'invoices',
    'bills',
    'payments',
    'payroll',
    'ar_aging',
    'ap_aging',
    'balance_sheet',
    'profit_loss',
    'other'
  )),
  original_filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','reviewed','applied','void')),
  row_count INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2),
  imported_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quickbooks_import_rows (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES quickbooks_import_batches(id) ON DELETE CASCADE,
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
  review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (review_status IN ('needs_review','ready','applied','ignored')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quickbooks_connections (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  realm_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT DEFAULT 'bearer',
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  connected_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  default_item_id TEXT,
  default_item_name TEXT,
  default_income_account_id TEXT,
  default_income_account_name TEXT,
  settings_updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS quickbooks_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('customer','invoice')),
  entity_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  quickbooks_id TEXT,
  message TEXT,
  request_json JSONB,
  response_json JSONB,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quickbooks_webhook_events (
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

-- ========== PAYROLL ==========
-- QuickBooks Payroll remains the payroll source of truth. Forge stores/imports
-- payroll data for admin review, labor costing, and project profitability.
CREATE TABLE IF NOT EXISTS payroll_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_pay_schedule TEXT,
  next_pay_date DATE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'quickbooks', 'import')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_employees (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  quickbooks_employee_id TEXT,
  quickbooks_display_name TEXT,
  display_name TEXT NOT NULL,
  email TEXT,
  role_title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  pay_type TEXT NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary', 'hourly', 'contract', 'other')),
  pay_rate_amount NUMERIC(14,4),
  pay_rate_period TEXT CHECK (pay_rate_period IS NULL OR pay_rate_period IN ('year', 'hour', 'day', 'pay_period', 'other')),
  pay_method TEXT,
  pay_schedule TEXT,
  imported_from TEXT,
  imported_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quickbooks_employee_id)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'quickbooks', 'import')),
  source_batch_id BIGINT REFERENCES quickbooks_import_batches(id) ON DELETE SET NULL,
  pay_period_start DATE,
  pay_period_end DATE,
  pay_date DATE,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'reviewed', 'approved', 'paid', 'void')),
  gross_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  employer_taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_run_lines (
  id BIGSERIAL PRIMARY KEY,
  payroll_run_id BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  payroll_employee_id BIGINT REFERENCES payroll_employees(id) ON DELETE SET NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  work_order_id BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
  earning_type TEXT,
  regular_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  employer_taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  allocation_status TEXT NOT NULL DEFAULT 'unallocated' CHECK (allocation_status IN ('unallocated', 'allocated', 'ignored')),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== INDEXES ==========
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_assigned ON jobs(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_job_members_job ON job_members(job_id);
CREATE INDEX IF NOT EXISTS idx_job_members_user ON job_members(user_id);

-- ========== PROJECT MEETINGS ==========
CREATE TABLE IF NOT EXISTS project_meetings (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_by_user_id BIGINT REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  meeting_link TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  reminder_setting TEXT NOT NULL DEFAULT '1d' CHECK(reminder_setting IN ('none','1d','12h','6h','1h')),
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES project_meetings(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp_token TEXT NOT NULL UNIQUE,
  response TEXT NOT NULL DEFAULT 'pending' CHECK(response IN ('pending','accept','decline','maybe')),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_meetings_job ON project_meetings(job_id);
CREATE INDEX IF NOT EXISTS idx_project_meetings_start ON project_meetings(start_time);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_token ON meeting_attendees(rsvp_token);

-- ========== PROJECT CHAT ==========
CREATE TABLE IF NOT EXISTS project_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_chat_job ON project_chat_messages(job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_wo_job ON work_orders(job_id);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_wo_parent ON work_orders(parent_wo_id);
CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_wo_scheduled ON work_orders(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_wo_main ON work_orders(wo_number_main, wo_number_sub);

CREATE INDEX IF NOT EXISTS idx_estimates_wo ON estimates(work_order_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);

CREATE INDEX IF NOT EXISTS idx_invoices_estimate ON invoices(estimate_id);
CREATE INDEX IF NOT EXISTS idx_invoices_wo ON invoices(work_order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);

CREATE INDEX IF NOT EXISTS idx_woli_wo ON work_order_line_items(work_order_id);
CREATE INDEX IF NOT EXISTS idx_eli_estimate ON estimate_line_items(estimate_id);
CREATE INDEX IF NOT EXISTS idx_ili_invoice ON invoice_line_items(invoice_id);

CREATE INDEX IF NOT EXISTS idx_wo_notes_wo ON wo_notes(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_photos_wo ON wo_photos(work_order_id);

CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_account_id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name);
CREATE INDEX IF NOT EXISTS idx_vendors_archived ON vendors(archived);

CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_job ON bills(job_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill ON bill_lines(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_account ON bill_lines(account_id);

CREATE INDEX IF NOT EXISTS idx_ai_extractions_status ON ai_extractions(status);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_logs(source);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_pending_confirms_user ON pending_confirmations(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_confirms_status_expires ON pending_confirmations(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_qb_import_batches_source ON quickbooks_import_batches(source_type);
CREATE INDEX IF NOT EXISTS idx_qb_import_batches_status ON quickbooks_import_batches(status);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_batch ON quickbooks_import_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_type ON quickbooks_import_rows(row_type);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_review ON quickbooks_import_rows(review_status);
CREATE INDEX IF NOT EXISTS idx_qb_import_rows_external_number ON quickbooks_import_rows(external_number);
CREATE INDEX IF NOT EXISTS idx_customers_quickbooks_id ON customers(quickbooks_id);
CREATE INDEX IF NOT EXISTS idx_invoices_quickbooks_id ON invoices(quickbooks_id);
CREATE INDEX IF NOT EXISTS idx_invoices_qb_sync_status ON invoices(quickbooks_sync_status);
CREATE INDEX IF NOT EXISTS idx_qb_sync_logs_entity ON quickbooks_sync_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_qb_connections_realm ON quickbooks_connections(realm_id);
CREATE INDEX IF NOT EXISTS idx_qb_webhook_events_status ON quickbooks_webhook_events(processed_status, created_at);
CREATE INDEX IF NOT EXISTS idx_qb_webhook_events_entity ON quickbooks_webhook_events(entity_name, entity_id);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_status ON payroll_employees(status);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_user ON payroll_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_pay_date ON payroll_runs(pay_date);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_run ON payroll_run_lines(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_employee ON payroll_run_lines(payroll_employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_job ON payroll_run_lines(job_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_wo ON payroll_run_lines(work_order_id);

-- ========== auto-update updated_at on row updates (Postgres trigger) ==========
CREATE OR REPLACE FUNCTION set_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'users','customers','jobs','work_orders','estimates','invoices',
    'accounts','vendors','bills','quickbooks_import_batches','quickbooks_import_rows',
    'payroll_settings','payroll_employees','payroll_runs','payroll_run_lines'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at_column()', t, t);
  END LOOP;
END$$;
