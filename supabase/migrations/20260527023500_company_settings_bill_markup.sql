-- Keep production company settings aligned with the app defaults form.
alter table public.company_settings
  add column if not exists default_bill_markup_pct numeric(8,4) not null default 25;

select pg_notify('pgrst', 'reload schema');
