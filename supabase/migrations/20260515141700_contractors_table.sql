-- D-079: Contractors table (subcontracted workers — parallel to vendors/suppliers)
CREATE TABLE IF NOT EXISTS contractors (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  email text,
  phone text,
  address text,
  city text,
  state text,
  zip text,
  trade text,                 -- drywall, plumbing, electrical, HVAC, general, other
  license_number text,
  insurance_expiry_date date,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contractors_name ON contractors(name);
CREATE INDEX IF NOT EXISTS idx_contractors_trade ON contractors(trade);
CREATE INDEX IF NOT EXISTS idx_contractors_active ON contractors(active);
