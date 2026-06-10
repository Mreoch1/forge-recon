begin;

alter table public.customers
  add column if not exists default_income_account_id bigint references public.accounts(id) on delete set null;

alter table public.vendors
  add column if not exists default_expense_account_id bigint references public.accounts(id) on delete set null;

alter table public.contractors
  add column if not exists default_expense_account_id bigint references public.accounts(id) on delete set null;

create table if not exists public.bank_transactions (
  id bigserial primary key,
  account_name text not null default 'Checking',
  transaction_date date not null,
  bank_detail text not null default '',
  payee text,
  account_id bigint references public.accounts(id) on delete set null,
  match_status text not null default 'for_review'
    check (match_status in ('for_review', 'categorized', 'excluded')),
  suggested_match_type text,
  suggested_match_id bigint,
  spent numeric(14,2) not null default 0,
  received numeric(14,2) not null default 0,
  memo text,
  attachment_count integer not null default 0,
  reviewed_by_user_id bigint references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bank_transactions_status on public.bank_transactions(match_status);
create index if not exists idx_bank_transactions_date on public.bank_transactions(transaction_date);
create index if not exists idx_bank_transactions_account on public.bank_transactions(account_id);

drop trigger if exists trg_bank_transactions_updated_at on public.bank_transactions;
create trigger trg_bank_transactions_updated_at
  before update on public.bank_transactions
  for each row execute function public.set_updated_at_column();

alter table public.bank_transactions enable row level security;
grant all privileges on table public.bank_transactions to service_role;
grant all privileges on sequence public.bank_transactions_id_seq to service_role;

commit;
