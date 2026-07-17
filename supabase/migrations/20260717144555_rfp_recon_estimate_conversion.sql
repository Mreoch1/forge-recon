alter table public.work_orders
  add column if not exists source_rfp_id bigint references public.project_rfps(id) on delete set null;

alter table public.estimates
  add column if not exists source_rfp_id bigint references public.project_rfps(id) on delete set null;

create unique index if not exists work_orders_source_rfp_id_unique
  on public.work_orders(source_rfp_id)
  where source_rfp_id is not null;

create unique index if not exists estimates_source_rfp_id_unique
  on public.estimates(source_rfp_id)
  where source_rfp_id is not null;

create or replace function public.create_recon_estimate_from_rfp(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_rfp_id bigint := nullif(payload->>'source_rfp_id', '')::bigint;
  v_source_job_id bigint := nullif(payload->>'job_id', '')::bigint;
  v_source_customer_id bigint := nullif(payload->>'customer_id', '')::bigint;
  v_actor_user_id bigint := nullif(payload->>'user_id', '')::bigint;
  v_existing_estimate_id bigint;
  v_work_order_id bigint;
  v_estimate_id bigint;
  v_next_main integer;
  v_display_number text;
begin
  if v_source_rfp_id is null or v_source_job_id is null then
    raise exception 'RFP category and project are required.';
  end if;

  if jsonb_array_length(coalesce(payload->'estimate_lines', '[]'::jsonb)) = 0 then
    raise exception 'At least one approved RFP line is required.';
  end if;

  if not exists (
    select 1
    from public.project_rfps r
    where r.id = v_source_rfp_id
      and r.job_id = v_source_job_id
  ) then
    raise exception 'RFP category does not belong to this project.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(v_source_rfp_id);

  select e.id, e.work_order_id
    into v_existing_estimate_id, v_work_order_id
  from public.estimates e
  where e.source_rfp_id = v_source_rfp_id
  limit 1;

  if v_existing_estimate_id is not null then
    select w.display_number into v_display_number
    from public.work_orders w
    where w.id = v_work_order_id;

    return jsonb_build_object(
      'created', false,
      'work_order_id', v_work_order_id,
      'estimate_id', v_existing_estimate_id,
      'display_number', v_display_number
    );
  end if;

  select w.id, w.display_number
    into v_work_order_id, v_display_number
  from public.work_orders w
  where w.source_rfp_id = v_source_rfp_id
  limit 1;

  if v_work_order_id is null then
    select s.next_wo_main_number
      into v_next_main
    from public.company_settings s
    where s.id = 1
    for update;

    if v_next_main is null then
      raise exception 'Company work-order numbering is not initialized.';
    end if;

    update public.company_settings
    set next_wo_main_number = v_next_main + 1
    where id = 1;

    v_display_number := case
      when length(v_next_main::text) < 4 then lpad(v_next_main::text, 4, '0')
      else v_next_main::text
    end || '-0000';

    insert into public.work_orders (
      job_id,
      customer_id,
      parent_wo_id,
      wo_number_main,
      wo_number_sub,
      display_number,
      status,
      description,
      notes,
      source_rfp_id
    ) values (
      v_source_job_id,
      v_source_customer_id,
      null,
      v_next_main,
      0,
      v_display_number,
      'open',
      nullif(payload->>'work_order_description', ''),
      nullif(payload->>'work_order_notes', ''),
      v_source_rfp_id
    ) returning id into v_work_order_id;

    insert into public.work_order_line_items (
      work_order_id,
      description,
      quantity,
      unit,
      unit_price,
      cost,
      line_total,
      completed,
      sort_order
    )
    select
      v_work_order_id,
      line->>'description',
      coalesce(nullif(line->>'quantity', '')::numeric, 0),
      coalesce(nullif(line->>'unit', ''), 'ea'),
      coalesce(nullif(line->>'unit_price', '')::numeric, 0),
      coalesce(nullif(line->>'cost', '')::numeric, 0),
      coalesce(nullif(line->>'line_total', '')::numeric, 0),
      0,
      coalesce(nullif(line->>'sort_order', '')::integer, 0)
    from jsonb_array_elements(coalesce(payload->'work_order_lines', '[]'::jsonb)) as line;
  end if;

  insert into public.estimates (
    work_order_id,
    status,
    subtotal,
    tax_rate,
    tax_amount,
    total,
    cost_total,
    valid_until,
    notes,
    source_rfp_id
  ) values (
    v_work_order_id,
    'draft',
    coalesce(nullif(payload->>'subtotal', '')::numeric, 0),
    coalesce(nullif(payload->>'tax_rate', '')::numeric, 0),
    coalesce(nullif(payload->>'tax_amount', '')::numeric, 0),
    coalesce(nullif(payload->>'total', '')::numeric, 0),
    coalesce(nullif(payload->>'cost_total', '')::numeric, 0),
    nullif(payload->>'valid_until', '')::date,
    nullif(payload->>'estimate_notes', ''),
    v_source_rfp_id
  ) returning id into v_estimate_id;

  insert into public.estimate_line_items (
    estimate_id,
    description,
    quantity,
    unit,
    unit_price,
    cost,
    line_total,
    labor_cost,
    material_cost,
    markup_pct,
    selected,
    sort_order
  )
  select
    v_estimate_id,
    line->>'description',
    coalesce(nullif(line->>'quantity', '')::numeric, 0),
    coalesce(nullif(line->>'unit', ''), 'ea'),
    coalesce(nullif(line->>'unit_price', '')::numeric, 0),
    coalesce(nullif(line->>'cost', '')::numeric, 0),
    coalesce(nullif(line->>'line_total', '')::numeric, 0),
    coalesce(nullif(line->>'labor_cost', '')::numeric, 0),
    coalesce(nullif(line->>'material_cost', '')::numeric, 0),
    coalesce(nullif(line->>'markup_pct', '')::numeric, 0),
    1,
    coalesce(nullif(line->>'sort_order', '')::integer, 0)
  from jsonb_array_elements(payload->'estimate_lines') as line;

  insert into public.audit_logs (
    entity_type,
    entity_id,
    action,
    before_json,
    after_json,
    source,
    user_id
  ) values
    (
      'work_order',
      v_work_order_id,
      'create_from_rfp',
      null,
      jsonb_build_object('source_rfp_id', v_source_rfp_id, 'estimate_id', v_estimate_id),
      'user',
      v_actor_user_id
    ),
    (
      'estimate',
      v_estimate_id,
      'create_from_rfp',
      null,
      jsonb_build_object('source_rfp_id', v_source_rfp_id, 'work_order_id', v_work_order_id),
      'user',
      v_actor_user_id
    );

  return jsonb_build_object(
    'created', true,
    'work_order_id', v_work_order_id,
    'estimate_id', v_estimate_id,
    'display_number', v_display_number
  );
end;
$$;

revoke execute on function public.create_recon_estimate_from_rfp(jsonb) from public, anon, authenticated;
grant execute on function public.create_recon_estimate_from_rfp(jsonb) to service_role;
