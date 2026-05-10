-- Accounting schema (v0.6).
-- Applied independently via init-accounting.js. Composes with the main app
-- schema (schema.sql) — references users(id) and invoices(id) defined there.

-- ========== Chart of accounts ==========
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,           -- e.g. "1100" = Accounts Receivable
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  parent_account_id INTEGER REFERENCES accounts(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== Journal entries (double-entry) ==========
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT,                    -- 'invoice'|'payment'|'bill'|'bill_payment'|'manual'
  source_id INTEGER,                   -- polymorphic FK
  created_by_user_id INTEGER REFERENCES users(id),
  reversed_by_entry_id INTEGER REFERENCES journal_entries(id),  -- for void/reversal
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  description TEXT DEFAULT ''
);

-- ========== Vendors ==========
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  ein TEXT,
  default_expense_account_id INTEGER REFERENCES accounts(id),
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== Bills (vendor invoices we owe) ==========
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  bill_number TEXT,                    -- vendor-provided number, free-form
  job_id INTEGER REFERENCES jobs(id),  -- optional: tie to a job for cost-tracking
  work_order_id INTEGER REFERENCES work_orders(id),  -- optional
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','approved','paid','void')),
  bill_date TEXT,
  due_date TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' or 'ai'
  created_by_user_id INTEGER REFERENCES users(id),
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ========== AI extractions + approval queue ==========
-- For uploaded vendor invoices that AI has parsed but a human hasn't approved.
CREATE TABLE IF NOT EXISTS ai_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_filename TEXT NOT NULL,        -- path under public/uploads/bills/
  extracted_json TEXT NOT NULL,         -- full AI output, JSON-encoded
  vendor_match_id INTEGER REFERENCES vendors(id),
  suggested_account_id INTEGER REFERENCES accounts(id),
  confidence REAL,                      -- 0..1
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','superseded')),
  approved_by_user_id INTEGER REFERENCES users(id),
  resulting_bill_id INTEGER REFERENCES bills(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== Audit log ==========
-- Every mutation on financial records leaves a row here. before_json/after_json
-- are JSON snapshots of the row (or relevant subset). source distinguishes
-- user-driven from AI-driven from automated (Stripe webhook, Plaid sync, system).
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,            -- 'invoice'|'bill'|'payment'|'journal_entry'|...
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,                 -- 'create'|'update'|'delete'|'status_change'|'post_je'|...
  before_json TEXT,
  after_json TEXT,
  source TEXT NOT NULL DEFAULT 'user'   -- 'user'|'ai'|'stripe'|'plaid'|'system'
    CHECK(source IN ('user','ai','stripe','plaid','system')),
  user_id INTEGER REFERENCES users(id),
  reason TEXT,                          -- optional human-supplied note
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== Indexes ==========
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
