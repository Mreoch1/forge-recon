-- Keep payroll updated_at triggers in sync on databases where payroll tables
-- were created before the trigger block was added to the foundation migration.
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'payroll_settings',
    'payroll_employees',
    'payroll_runs',
    'payroll_run_lines'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_column()', t, t);
  END LOOP;
END $$;
