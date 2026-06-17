begin;

alter table public.generated_documents
  add column if not exists requirement_id bigint references public.preconstruction_document_requirements(id) on delete set null;

create index if not exists generated_documents_requirement_idx on public.generated_documents(requirement_id);

commit;
