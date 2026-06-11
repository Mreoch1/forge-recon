ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS mhelpdesk_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mhelpdesk_customer_id
  ON public.customers(mhelpdesk_customer_id)
  WHERE mhelpdesk_customer_id IS NOT NULL;
