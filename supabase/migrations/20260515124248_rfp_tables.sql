CREATE TABLE IF NOT EXISTS project_rfps (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  contractor_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','awarded','declined')),
  notes text,
  created_by_user_id bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_rfps_job_id ON project_rfps(job_id);

CREATE TABLE IF NOT EXISTS rfp_line_items (
  id bigserial PRIMARY KEY,
  rfp_id bigint NOT NULL REFERENCES project_rfps(id) ON DELETE CASCADE,
  parent_line_item_id bigint REFERENCES rfp_line_items(id) ON DELETE SET NULL,
  vendor text,
  description text NOT NULL,
  quantity numeric(14,4) DEFAULT 0,
  contractor_cost numeric(14,2) DEFAULT 0,
  vendor_cost numeric(14,2) DEFAULT 0,
  unit_cost numeric(14,2) DEFAULT 0,
  total_cost numeric(14,2) DEFAULT 0,
  markup_pct numeric(5,2) DEFAULT 20,
  total_with_markup numeric(14,2) DEFAULT 0,
  final_unit_cost numeric(14,2) DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  is_subtotal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rfp_line_items_rfp_id ON rfp_line_items(rfp_id);
CREATE INDEX IF NOT EXISTS idx_rfp_line_items_parent ON rfp_line_items(parent_line_item_id);
