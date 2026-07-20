-- Allow administrators to correct or remove unpaid bills without leaving stale
-- AP journal entries or bill-generated draft customer paperwork behind.

-- These linkage columns were historically added by app startup. Keep the
-- database migration self-contained for environments where startup DDL was
-- skipped or disabled.
alter table public.estimate_line_items
  add column if not exists source_bill_id bigint references public.bills(id) on delete set null,
  add column if not exists source_bill_line_id bigint references public.bill_lines(id) on delete set null;

alter table public.invoice_line_items
  add column if not exists source_bill_id bigint references public.bills(id) on delete set null,
  add column if not exists source_bill_line_id bigint references public.bill_lines(id) on delete set null;

create index if not exists idx_estimate_line_items_source_bill
  on public.estimate_line_items(source_bill_id);
create index if not exists idx_invoice_line_items_source_bill
  on public.invoice_line_items(source_bill_id);

create or replace function public.edit_unpaid_bill_with_lines(
  p_bill_id bigint,
  p_bill_data jsonb,
  p_lines jsonb,
  p_user_id bigint default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill public.bills%rowtype;
  v_entry_id bigint;
  v_ap_account_id bigint;
  v_tax_account_id bigint;
  v_description text;
  v_total numeric(14,2);
  v_tax_amount numeric(14,2);
  v_line_subtotal numeric(14,2);
begin
  select * into v_bill
    from public.bills
   where id = p_bill_id
   for update;

  if not found then
    raise exception 'Bill not found';
  end if;
  if v_bill.status not in ('draft', 'approved') or coalesce(v_bill.amount_paid, 0) > 0 then
    raise exception 'Only unpaid draft or approved bills can be edited';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one bill line is required';
  end if;

  v_total := coalesce((p_bill_data->>'total')::numeric, 0);
  v_tax_amount := coalesce((p_bill_data->>'tax_amount')::numeric, 0);
  select coalesce(sum(coalesce((line->>'line_total')::numeric, 0)), 0)
    into v_line_subtotal
    from jsonb_array_elements(p_lines) as line;

  if v_line_subtotal < 0 or v_tax_amount < 0 or v_total < 0 then
    raise exception 'Bill totals cannot be negative';
  end if;
  if round(v_line_subtotal + v_tax_amount, 2) <> round(v_total, 2) then
    raise exception 'Bill line totals plus tax must equal the bill total';
  end if;

  update public.bills
     set vendor_id = (p_bill_data->>'vendor_id')::bigint,
         job_id = nullif(p_bill_data->>'job_id', '')::bigint,
         work_order_id = nullif(p_bill_data->>'work_order_id', '')::bigint,
         bill_number = nullif(p_bill_data->>'bill_number', ''),
         subtotal = v_line_subtotal,
         tax_amount = v_tax_amount,
         total = v_total,
         due_date = nullif(p_bill_data->>'due_date', '')::date,
         bill_date = nullif(p_bill_data->>'bill_date', '')::date,
         notes = nullif(p_bill_data->>'notes', ''),
         updated_at = now()
   where id = p_bill_id;

  delete from public.bill_lines where bill_id = p_bill_id;

  insert into public.bill_lines
    (bill_id, account_id, description, quantity, unit_price, line_total, sort_order)
  select p_bill_id,
         (line->>'account_id')::bigint,
         line->>'description',
         coalesce((line->>'quantity')::numeric, 0),
         coalesce((line->>'unit_price')::numeric, 0),
         coalesce((line->>'line_total')::numeric, 0),
         coalesce((line->>'sort_order')::integer, 0)
    from jsonb_array_elements(p_lines) as line;

  -- Approved bills are already in AP. Rebuild the active posting in this same
  -- transaction so the ledger can never show the old amount after an edit.
  if v_bill.status = 'approved' then
    select id into v_entry_id
      from public.journal_entries
     where source_type = 'bill'
       and source_id = p_bill_id
       and reversed_by_entry_id is null
     order by id desc
     limit 1;

    if v_total <= 0 then
      if v_entry_id is not null then
        delete from public.journal_entries where id = v_entry_id;
      end if;
    else
      select id into v_ap_account_id
        from public.accounts
       where code = '2000' and active = true
       limit 1;
      if v_ap_account_id is null then
        raise exception 'Accounts Payable account 2000 is not configured';
      end if;

      v_description := 'Bill ' || coalesce(nullif(p_bill_data->>'bill_number', ''), '#' || p_bill_id::text) || ' from vendor';
      if v_entry_id is null then
        insert into public.journal_entries
          (entry_date, description, source_type, source_id, created_by_user_id)
        values
          (coalesce(nullif(p_bill_data->>'bill_date', '')::date, current_date), v_description, 'bill', p_bill_id, p_user_id)
        returning id into v_entry_id;
      else
        update public.journal_entries
           set entry_date = coalesce(nullif(p_bill_data->>'bill_date', '')::date, current_date),
               description = v_description
         where id = v_entry_id;
        delete from public.journal_lines where journal_entry_id = v_entry_id;
      end if;

      insert into public.journal_lines
        (journal_entry_id, account_id, debit, credit, description)
      select v_entry_id,
             bl.account_id,
             bl.line_total,
             0,
             v_description || ' - ' || coalesce(nullif(bl.description, ''), 'expense')
        from public.bill_lines bl
       where bl.bill_id = p_bill_id and bl.line_total > 0;

      if v_tax_amount > 0 then
        select id into v_tax_account_id
          from public.accounts
         where code = '5950' and active = true
         limit 1;
        if v_tax_account_id is null then
          raise exception 'Bill sales-tax account 5950 is not configured';
        end if;
        insert into public.journal_lines
          (journal_entry_id, account_id, debit, credit, description)
        values
          (v_entry_id, v_tax_account_id, v_tax_amount, 0, v_description || ' - sales tax');
      end if;

      insert into public.journal_lines
        (journal_entry_id, account_id, debit, credit, description)
      values
        (v_entry_id, v_ap_account_id, 0, v_total, v_description || ' - to AP');
    end if;
  end if;

  insert into public.audit_logs
    (entity_type, entity_id, action, before_json, after_json, source, user_id)
  values
    ('bill', p_bill_id, 'update',
     jsonb_build_object('vendor_id', v_bill.vendor_id, 'bill_number', v_bill.bill_number,
                        'work_order_id', v_bill.work_order_id, 'subtotal', v_bill.subtotal,
                        'tax_amount', v_bill.tax_amount, 'total', v_bill.total, 'status', v_bill.status),
     jsonb_build_object('vendor_id', (p_bill_data->>'vendor_id')::bigint,
                        'bill_number', nullif(p_bill_data->>'bill_number', ''),
                        'work_order_id', nullif(p_bill_data->>'work_order_id', '')::bigint,
                        'subtotal', v_line_subtotal,
                        'tax_amount', v_tax_amount, 'total', v_total, 'status', v_bill.status),
     'user', p_user_id);
end;
$$;

revoke execute on function public.edit_unpaid_bill_with_lines(bigint, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.edit_unpaid_bill_with_lines(bigint, jsonb, jsonb, bigint) to service_role;

create or replace function public.delete_unpaid_bill(
  p_bill_id bigint,
  p_user_id bigint default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill public.bills%rowtype;
  v_parent record;
begin
  select * into v_bill
    from public.bills
   where id = p_bill_id
   for update;

  if not found then
    raise exception 'Bill not found';
  end if;
  if v_bill.status = 'paid' or coalesce(v_bill.amount_paid, 0) > 0 then
    raise exception 'Paid or partially paid bills cannot be deleted';
  end if;

  -- Remove generated lines only from editable customer paperwork and refresh
  -- those document totals. Sent/approved paperwork remains as a historical
  -- document and is merely unlinked when the bill is deleted below.
  for v_parent in
    select distinct e.id, e.tax_rate
      from public.estimates e
      join public.estimate_line_items li on li.estimate_id = e.id
     where li.source_bill_id = p_bill_id and e.status in ('new', 'draft')
  loop
    delete from public.estimate_line_items
     where estimate_id = v_parent.id and source_bill_id = p_bill_id;
    update public.estimates
       set subtotal = coalesce((select sum(line_total) from public.estimate_line_items where estimate_id = v_parent.id), 0),
           cost_total = coalesce((select sum(cost * quantity) from public.estimate_line_items where estimate_id = v_parent.id), 0),
           tax_amount = round(coalesce((select sum(line_total) from public.estimate_line_items where estimate_id = v_parent.id), 0) * coalesce(v_parent.tax_rate, 0) / 100, 2),
           total = coalesce((select sum(line_total) from public.estimate_line_items where estimate_id = v_parent.id), 0)
             + round(coalesce((select sum(line_total) from public.estimate_line_items where estimate_id = v_parent.id), 0) * coalesce(v_parent.tax_rate, 0) / 100, 2),
           updated_at = now()
     where id = v_parent.id;
  end loop;

  for v_parent in
    select distinct i.id, i.tax_rate
      from public.invoices i
      join public.invoice_line_items li on li.invoice_id = i.id
     where li.source_bill_id = p_bill_id and i.status = 'draft'
  loop
    delete from public.invoice_line_items
     where invoice_id = v_parent.id and source_bill_id = p_bill_id;
    update public.invoices
       set subtotal = coalesce((select sum(line_total) from public.invoice_line_items where invoice_id = v_parent.id), 0),
           cost_total = coalesce((select sum(cost * quantity) from public.invoice_line_items where invoice_id = v_parent.id), 0),
           tax_amount = round(coalesce((select sum(line_total) from public.invoice_line_items where invoice_id = v_parent.id), 0) * coalesce(v_parent.tax_rate, 0) / 100, 2),
           total = coalesce((select sum(line_total) from public.invoice_line_items where invoice_id = v_parent.id), 0)
             + round(coalesce((select sum(line_total) from public.invoice_line_items where invoice_id = v_parent.id), 0) * coalesce(v_parent.tax_rate, 0) / 100, 2),
           updated_at = now()
     where id = v_parent.id;
  end loop;

  update public.estimate_line_items
     set source_bill_id = null, source_bill_line_id = null
   where source_bill_id = p_bill_id;
  update public.invoice_line_items
     set source_bill_id = null, source_bill_line_id = null
   where source_bill_id = p_bill_id;

  update public.journal_entries
     set reversed_by_entry_id = null
   where reversed_by_entry_id in (
     select id from public.journal_entries
      where source_id = p_bill_id and source_type in ('bill', 'bill_void', 'bill_payment')
   );
  delete from public.journal_entries
   where source_id = p_bill_id and source_type in ('bill', 'bill_void', 'bill_payment');

  insert into public.audit_logs
    (entity_type, entity_id, action, before_json, after_json, source, user_id)
  values
    ('bill', p_bill_id, 'delete',
     jsonb_build_object('vendor_id', v_bill.vendor_id, 'bill_number', v_bill.bill_number,
                        'work_order_id', v_bill.work_order_id, 'subtotal', v_bill.subtotal,
                        'tax_amount', v_bill.tax_amount, 'total', v_bill.total, 'status', v_bill.status),
     null, 'user', p_user_id);

  delete from public.bills where id = p_bill_id;
end;
$$;

revoke execute on function public.delete_unpaid_bill(bigint, bigint) from public, anon, authenticated;
grant execute on function public.delete_unpaid_bill(bigint, bigint) to service_role;
