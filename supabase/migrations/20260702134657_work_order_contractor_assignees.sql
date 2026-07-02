CREATE TABLE IF NOT EXISTS public.work_order_contractors (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  contractor_id BIGINT NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(work_order_id, contractor_id)
);

CREATE INDEX IF NOT EXISTS idx_work_order_contractors_wo
  ON public.work_order_contractors(work_order_id);

CREATE INDEX IF NOT EXISTS idx_work_order_contractors_contractor
  ON public.work_order_contractors(contractor_id);

ALTER TABLE public.work_order_contractors ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.work_order_contractors TO service_role;
GRANT ALL ON SEQUENCE public.work_order_contractors_id_seq TO service_role;
