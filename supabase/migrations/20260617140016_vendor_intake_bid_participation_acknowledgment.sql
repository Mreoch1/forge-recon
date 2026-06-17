ALTER TABLE public.contractor_vendor_intakes
  ADD COLUMN IF NOT EXISTS bid_participation_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bid_non_circumvention_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bid_direct_contact_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bid_future_agreement_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bid_participation_acknowledged_at TIMESTAMPTZ;
