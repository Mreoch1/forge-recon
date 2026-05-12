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
  notes TEXT,
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
    CHECK(status IN ('draft','sent','accepted','rejected','expired')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(8,4) NOT NULL DEFAULT 0,    -- e.g. 6.2500 = 6.25%
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_terms TEXT NOT NULL DEFAULT 'Net 30',
  valid_until DATE,
  notes TEXT,
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
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ========== INVOICES ==========
CREATE TABLE IF NOT EXISTS invoices (
  id BIGSERIAL PRIMARY KEY,
  estimate_id BIGINT NOT NULL UNIQUE REFERENCES estimates(id),
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','sent','paid','overdue','void')),
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
  notes TEXT,
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
  sort_order INTEGER NOT NULL DEFAULT 0
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
  filename TEXT NOT NULL,         -- relative path under uploads/wo/<wo_id>/
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

-- ========== INDEXES ==========
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_assigned ON jobs(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_date);

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
    'accounts','vendors','bills'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at_column()', t, t);
  END LOOP;
END$$;
