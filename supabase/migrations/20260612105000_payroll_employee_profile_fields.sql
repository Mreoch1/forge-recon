-- Expand the payroll employee roster into an editable admin employee profile.
-- QuickBooks Payroll remains the source of truth for payroll runs and filings;
-- Forge stores the operational profile data needed for reports and labor costing.

ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS preferred_name TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS mobile_phone TEXT,
  ADD COLUMN IF NOT EXISTS home_phone TEXT,
  ADD COLUMN IF NOT EXISTS work_phone TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS zip TEXT,
  ADD COLUMN IF NOT EXISTS hire_date DATE,
  ADD COLUMN IF NOT EXISTS birth_date DATE,
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS ssn_last4 TEXT,
  ADD COLUMN IF NOT EXISTS employee_identifier TEXT,
  ADD COLUMN IF NOT EXISTS employment_type TEXT,
  ADD COLUMN IF NOT EXISTS department TEXT,
  ADD COLUMN IF NOT EXISTS manager_name TEXT,
  ADD COLUMN IF NOT EXISTS work_location TEXT,
  ADD COLUMN IF NOT EXISTS worker_comp_class TEXT,
  ADD COLUMN IF NOT EXISTS default_weekly_hours NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS pay_effective_date DATE,
  ADD COLUMN IF NOT EXISTS federal_filing_status TEXT,
  ADD COLUMN IF NOT EXISTS state_tax_status TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS additional_pay_types TEXT,
  ADD COLUMN IF NOT EXISTS deductions_and_contributions TEXT,
  ADD COLUMN IF NOT EXISTS documents_notes TEXT,
  ADD COLUMN IF NOT EXISTS time_off_notes TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE public.payroll_employees
  DROP CONSTRAINT IF EXISTS payroll_employees_ssn_last4_check;

ALTER TABLE public.payroll_employees
  ADD CONSTRAINT payroll_employees_ssn_last4_check
  CHECK (ssn_last4 IS NULL OR ssn_last4 ~ '^[0-9]{4}$');

CREATE INDEX IF NOT EXISTS idx_payroll_employees_display_name ON public.payroll_employees(display_name);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_pay_schedule ON public.payroll_employees(pay_schedule);

ALTER TABLE public.payroll_employees ENABLE ROW LEVEL SECURITY;
