CREATE OR REPLACE FUNCTION public.set_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

ALTER TABLE public.project_rfps
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.rfp_line_items
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS set_project_rfps_updated_at ON public.project_rfps;
CREATE TRIGGER set_project_rfps_updated_at
  BEFORE UPDATE ON public.project_rfps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();

DROP TRIGGER IF EXISTS set_rfp_line_items_updated_at ON public.rfp_line_items;
CREATE TRIGGER set_rfp_line_items_updated_at
  BEFORE UPDATE ON public.rfp_line_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column();
