alter table public.bills
  add column if not exists attachment_file_id bigint references public.files(id) on delete set null;

create index if not exists idx_bills_attachment_file_id
  on public.bills(attachment_file_id);
