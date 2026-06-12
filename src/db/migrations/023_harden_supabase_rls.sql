-- 023: Harden Supabase public-table security
--
-- FORGE uses the server-side Supabase service role for database access.
-- Browser clients should not have direct table access through anon/authenticated
-- PostgREST roles. Keep RLS enabled and grants closed on operational tables.

ALTER TABLE IF EXISTS public.project_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.project_material_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.project_material_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.project_material_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.quickbooks_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.quickbooks_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.project_chat_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_material_categories FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_material_items FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_material_vendors FROM anon, authenticated;
REVOKE ALL ON TABLE public.quickbooks_sync_log FROM anon, authenticated;
REVOKE ALL ON TABLE public.quickbooks_tokens FROM anon, authenticated;

ALTER FUNCTION public.update_invoice_with_lines(bigint, jsonb, jsonb)
  SET search_path = public;
