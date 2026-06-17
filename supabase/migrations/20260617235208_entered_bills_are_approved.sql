alter table public.bills
  alter column status set default 'approved';

update public.bills
set
  status = 'approved',
  approved_at = coalesce(approved_at, created_at, now()),
  updated_at = now()
where status = 'draft';
