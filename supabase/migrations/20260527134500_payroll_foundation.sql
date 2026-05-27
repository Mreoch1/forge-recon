-- Payroll foundation.
-- QuickBooks Payroll remains the payroll source of truth. Forge stores/imports
-- payroll data for admin review, labor costing, and project profitability.

ALTER TABLE public.quickbooks_import_batches
  DROP CONSTRAINT IF EXISTS quickbooks_import_batches_source_type_check;

ALTER TABLE public.quickbooks_import_batches
  ADD CONSTRAINT quickbooks_import_batches_source_type_check
  CHECK (source_type IN (
    'chart_of_accounts',
    'customers',
    'vendors',
    'products_services',
    'invoices',
    'bills',
    'payments',
    'payroll',
    'ar_aging',
    'ap_aging',
    'balance_sheet',
    'profit_loss',
    'other'
  ));

CREATE TABLE IF NOT EXISTS public.payroll_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_pay_schedule TEXT,
  next_pay_date DATE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'quickbooks', 'import')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payroll_employees (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  quickbooks_employee_id TEXT,
  quickbooks_display_name TEXT,
  display_name TEXT NOT NULL,
  email TEXT,
  role_title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  pay_type TEXT NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary', 'hourly', 'contract', 'other')),
  pay_rate_amount NUMERIC(14,4),
  pay_rate_period TEXT CHECK (pay_rate_period IS NULL OR pay_rate_period IN ('year', 'hour', 'day', 'pay_period', 'other')),
  pay_method TEXT,
  pay_schedule TEXT,
  imported_from TEXT,
  imported_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quickbooks_employee_id)
);

CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'quickbooks', 'import')),
  source_batch_id BIGINT REFERENCES public.quickbooks_import_batches(id) ON DELETE SET NULL,
  pay_period_start DATE,
  pay_period_end DATE,
  pay_date DATE,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'reviewed', 'approved', 'paid', 'void')),
  gross_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  employer_taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payroll_run_lines (
  id BIGSERIAL PRIMARY KEY,
  payroll_run_id BIGINT NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  payroll_employee_id BIGINT REFERENCES public.payroll_employees(id) ON DELETE SET NULL,
  user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  job_id BIGINT REFERENCES public.jobs(id) ON DELETE SET NULL,
  work_order_id BIGINT REFERENCES public.work_orders(id) ON DELETE SET NULL,
  earning_type TEXT,
  regular_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  employer_taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  allocation_status TEXT NOT NULL DEFAULT 'unallocated' CHECK (allocation_status IN ('unallocated', 'allocated', 'ignored')),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_status ON public.payroll_employees(status);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_user ON public.payroll_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_pay_date ON public.payroll_runs(pay_date);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON public.payroll_runs(status);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_run ON public.payroll_run_lines(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_employee ON public.payroll_run_lines(payroll_employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_job ON public.payroll_run_lines(job_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_wo ON public.payroll_run_lines(work_order_id);

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
