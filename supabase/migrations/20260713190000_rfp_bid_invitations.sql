begin;

-- D-142: lets a PM prepare an unpriced SOW/bid-request PDF addressed to a
-- specific contractor/vendor without touching real rfp_line_items pricing
-- sub-lines. Previously the only way to get a contractor-addressed PDF was
-- the /contractors/:id/handoff PDF, which only pulls sub-lines where
-- vendor = contractor.name — meaning a brand-new bidder required hijacking
-- an existing priced line, zeroing it out, generating the PDF, then
-- reverting it. This table is purely a "who should get this SOW" list,
-- decoupled from pricing.
create table if not exists public.rfp_bid_invitations (
  id bigserial primary key,
  rfp_id bigint not null references public.project_rfps(id) on delete cascade,
  recipient_name text not null,
  recipient_type text check (recipient_type in ('contractor', 'vendor')),
  contractor_id bigint references public.contractors(id) on delete set null,
  vendor_id bigint references public.vendors(id) on delete set null,
  created_by_user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rfp_bid_invitations_rfp on public.rfp_bid_invitations(rfp_id);

alter table public.rfp_bid_invitations enable row level security;
grant all privileges on table public.rfp_bid_invitations to service_role;
grant all privileges on sequence public.rfp_bid_invitations_id_seq to service_role;

commit;
