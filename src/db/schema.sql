-- Recon Construction WO — v0.5 schema
--
-- Major changes from v0:
--   * Flow reversed: customer -> job -> WO -> estimate -> invoice. WO is the root document.
--   * Sub-work orders: parent_wo_id self-FK, wo_number_main + wo_number_sub pair.
--     Display: WO-{main:0000}-{sub:0000}. Estimate + invoice inherit the WO's number.
--   * Single shared counter (next_wo_main_number) replaces three separate counters.
--   * Cost column on every line item (internal-only, never on customer PDFs).
--   * billing_email on customers (used for invoice send; falls back to email).
--   * payment_terms on invoices (Due on receipt / Net 15 / Net 30 / Net 45 / Net 60 / Custom).
--   * jobs: scheduled_date + scheduled_time + assigned_to.
--   * Drop trade column from line items (description is primary label).
--   * Roles: admin, manager, worker (added 'manager' and 'worker' for upcoming Round 4 tier work).
--
-- This schema is destructive vs v0 — run init-db on an empty data dir.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','manager','worker')),
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  mock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,           -- primary contact, used for estimate emails
  billing_email TEXT,   -- separate billing contact, used for invoices (falls back to email)
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  address TEXT,         -- pre-filled from customer.address on creation, editable
  city TEXT,
  state TEXT,
  zip TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK(status IN ('lead','estimating','scheduled','in_progress','complete','cancelled')),
  scheduled_date TEXT,    -- YYYY-MM-DD
  scheduled_time TEXT,    -- HH:MM
  assigned_to_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),

  parent_wo_id INTEGER REFERENCES work_orders(id),  -- NULL for root WOs, set for sub-WOs
  wo_number_main INTEGER NOT NULL,                  -- shared with all sub-WOs of the same parent
  wo_number_sub  INTEGER NOT NULL DEFAULT 0,        -- 0 for root, 1..N for sub-WOs

  -- Display number "0001-0000" derived from main+sub at render time. We store
  -- a denormalized text version for unique-by-display lookup + listing speed.
  display_number TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','in_progress','complete','cancelled')),

  scheduled_date TEXT,
  scheduled_time TEXT,
  completed_date TEXT,

  assigned_to_user_id INTEGER REFERENCES users(id),
  assigned_to TEXT,  -- free-text fallback for non-employee labor (subs, etc.)

  notes TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_order_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,           -- internal-only, never on PDF
  line_total REAL NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ========== ESTIMATES ==========
-- An estimate ALWAYS belongs to a work order (1:1 in v0.5).
-- Display number = WO display number. Status flow: draft -> sent -> accepted | rejected.

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL UNIQUE REFERENCES work_orders(id),  -- 1:1 with WO
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','sent','accepted','rejected','expired')),
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,    -- internal sum of cost column
  valid_until TEXT,
  notes TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimate_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 1,    -- if customer accepts only some lines (carries to invoice)
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ========== INVOICES ==========
-- An invoice ALWAYS belongs to an estimate (1:1) which belongs to a WO.
-- Display number = WO display number.

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL UNIQUE REFERENCES estimates(id),  -- 1:1 with estimate
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id),     -- denormalized for fast lookups
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','sent','paid','overdue','void')),
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_terms TEXT NOT NULL DEFAULT 'Net 30',  -- "Due on receipt" / "Net 15" / "Net 30" / "Net 45" / "Net 60" / "Custom"
  due_date TEXT,
  sent_at TEXT,
  paid_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ========== COMPANY SETTINGS ==========
CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  company_name TEXT NOT NULL DEFAULT 'Recon Construction',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  ein TEXT DEFAULT '',
  default_tax_rate REAL NOT NULL DEFAULT 0,
  default_payment_terms TEXT NOT NULL DEFAULT 'Net 30',
  next_wo_main_number INTEGER NOT NULL DEFAULT 1,
  logo_path TEXT NOT NULL DEFAULT '/logos/recon.png',
  current_year INTEGER NOT NULL DEFAULT 2026
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

CREATE INDEX IF NOT EXISTS idx_woli_wo ON work_order_line_items(work_order_id);
CREATE INDEX IF NOT EXISTS idx_eli_estimate ON estimate_line_items(estimate_id);
CREATE INDEX IF NOT EXISTS idx_ili_invoice ON invoice_line_items(invoice_id);

-- Notes audit log for WOs (Round 5 placeholder; create now so workers can use it once UI lands)
CREATE TABLE IF NOT EXISTS wo_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wo_notes_wo ON wo_notes(work_order_id);

-- Photo uploads on WOs (Round 5 placeholder)
CREATE TABLE IF NOT EXISTS wo_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  filename TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wo_photos_wo ON wo_photos(work_order_id);

-- Reusable items library (Round 3 placeholder; table exists, UI follows)
CREATE TABLE IF NOT EXISTS items_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  category TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
