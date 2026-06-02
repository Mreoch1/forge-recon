begin;

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;
revoke all privileges on all functions in schema public from public;
revoke all privileges on all functions in schema public from anon, authenticated;
revoke usage on schema public from anon, authenticated;

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

do $$
declare
  rec record;
begin
  for rec in
    select format('%I.%I', schemaname, tablename) as fqtn
    from pg_tables
    where schemaname = 'public'
  loop
    execute 'alter table ' || rec.fqtn || ' enable row level security';
  end loop;
end $$;

alter view if exists public.v_job_financials set (security_invoker = true);
alter function public.set_updated_at_column() set search_path = public;

commit;
