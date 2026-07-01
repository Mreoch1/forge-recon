CREATE TABLE IF NOT EXISTS public.contractor_vendor_intake_section_requests (
  id BIGSERIAL PRIMARY KEY,
  intake_id BIGINT NOT NULL REFERENCES public.contractor_vendor_intakes(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK (section IN ('company', 'experience', 'compliance', 'references', 'review')),
  requested_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cv_intake_section_requests_intake_section
  ON public.contractor_vendor_intake_section_requests(intake_id, section, sent_at DESC);

ALTER TABLE public.contractor_vendor_intake_section_requests ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.contractor_vendor_intake_section_requests TO service_role;
GRANT ALL ON SEQUENCE public.contractor_vendor_intake_section_requests_id_seq TO service_role;
