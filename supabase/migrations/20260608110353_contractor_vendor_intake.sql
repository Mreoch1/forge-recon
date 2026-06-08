CREATE TABLE IF NOT EXISTS public.contractor_vendor_intakes (
  id BIGSERIAL PRIMARY KEY,
  access_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'reviewing', 'approved', 'archived')),
  source TEXT NOT NULL DEFAULT 'email_link',

  company_name TEXT NOT NULL DEFAULT '',
  dba_name TEXT,
  company_type TEXT NOT NULL DEFAULT 'contractor' CHECK (company_type IN ('contractor', 'vendor', 'both', 'other')),
  trades TEXT[] NOT NULL DEFAULT '{}',
  service_area TEXT,

  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  office_phone TEXT,
  mobile_phone TEXT,
  email TEXT,
  website TEXT,

  primary_contact_name TEXT,
  primary_contact_title TEXT,
  primary_contact_phone TEXT,
  primary_contact_email TEXT,
  billing_contact_name TEXT,
  billing_contact_phone TEXT,
  billing_contact_email TEXT,

  years_in_business INTEGER,
  employee_count INTEGER,
  field_staff_count INTEGER,
  annual_capacity TEXT,
  largest_project_name TEXT,
  largest_project_location TEXT,
  largest_project_value NUMERIC(12,2),
  largest_project_date DATE,
  largest_project_description TEXT,
  occupied_multifamily BOOLEAN,
  occupied_multifamily_notes TEXT,

  hud_mshda_experience BOOLEAN,
  hud_mshda_notes TEXT,
  section3_business BOOLEAN,
  section3_notes TEXT,
  prevailing_wage_experience BOOLEAN,
  union_status TEXT NOT NULL DEFAULT 'unknown' CHECK (union_status IN ('union', 'non_union', 'mixed', 'unknown')),

  insurance_gl BOOLEAN,
  insurance_workers_comp BOOLEAN,
  insurance_auto BOOLEAN,
  insurance_expiration_date DATE,
  bondable BOOLEAN,
  license_numbers TEXT,
  references_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  certifications TEXT,
  safety_notes TEXT,
  documents_notes TEXT,

  internal_notes TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  reviewed_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  promoted_vendor_id BIGINT REFERENCES public.vendors(id) ON DELETE SET NULL,
  promoted_contractor_id BIGINT REFERENCES public.contractors(id) ON DELETE SET NULL,

  submitted_at TIMESTAMPTZ,
  last_update_reminder_sent_at TIMESTAMPTZ,
  next_update_due_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.contractor_vendor_intake_notes (
  id BIGSERIAL PRIMARY KEY,
  intake_id BIGINT NOT NULL REFERENCES public.contractor_vendor_intakes(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  note_type TEXT NOT NULL DEFAULT 'note' CHECK (note_type IN ('note', 'call', 'email', 'review')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_status ON public.contractor_vendor_intakes(status);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_company_name ON public.contractor_vendor_intakes(company_name);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_email ON public.contractor_vendor_intakes(email);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_location ON public.contractor_vendor_intakes(city, state);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_rating ON public.contractor_vendor_intakes(rating);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_submitted_at ON public.contractor_vendor_intakes(submitted_at);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intakes_trades ON public.contractor_vendor_intakes USING GIN(trades);
CREATE INDEX IF NOT EXISTS idx_contractor_vendor_intake_notes_intake ON public.contractor_vendor_intake_notes(intake_id, created_at DESC);

ALTER TABLE public.contractor_vendor_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_vendor_intake_notes ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.contractor_vendor_intakes TO service_role;
GRANT ALL ON TABLE public.contractor_vendor_intake_notes TO service_role;
GRANT ALL ON SEQUENCE public.contractor_vendor_intakes_id_seq TO service_role;
GRANT ALL ON SEQUENCE public.contractor_vendor_intake_notes_id_seq TO service_role;
