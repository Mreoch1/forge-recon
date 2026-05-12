CREATE OR REPLACE FUNCTION public.update_estimate_with_lines(p_estimate_id bigint, estimate_data jsonb, lines jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE estimates SET
    work_order_id = (estimate_data->>'work_order_id')::bigint,
    status = COALESCE(estimate_data->>'status', status),
    subtotal = (estimate_data->>'subtotal')::numeric,
    tax_rate = (estimate_data->>'tax_rate')::numeric,
    tax_amount = (estimate_data->>'tax_amount')::numeric,
    total = (estimate_data->>'total')::numeric,
    cost_total = (estimate_data->>'cost_total')::numeric,
    updated_at = now()
  WHERE id = p_estimate_id;
  DELETE FROM estimate_line_items WHERE estimate_id = p_estimate_id;
  INSERT INTO estimate_line_items (estimate_id, description, quantity, unit, unit_price, cost, line_total, selected, sort_order)
  SELECT p_estimate_id, line->>'description', (line->>'quantity')::numeric, line->>'unit',
    (line->>'unit_price')::numeric, (line->>'cost')::numeric, (line->>'line_total')::numeric,
    COALESCE((line->>'selected')::int, 1), COALESCE((line->>'sort_order')::int, 0)
  FROM jsonb_array_elements(lines) AS line;
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_estimate_with_lines TO service_role;

CREATE OR REPLACE FUNCTION public.convert_estimate_to_invoice(estimate_id bigint, selected_line_ids bigint[])
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv_id bigint;
  est RECORD;
  line RECORD;
  line_total numeric;
BEGIN
  SELECT e.*, w.job_id, w.display_number INTO est
  FROM estimates e JOIN work_orders w ON w.id = e.work_order_id WHERE e.id = estimate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Estimate not found'; END IF;
  INSERT INTO invoices (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, invoice_number, display_number)
  VALUES (estimate_id, est.work_order_id, 'draft', 0, est.tax_rate, 0, 0, est.cost_total,
    (SELECT COALESCE(MAX(invoice_number), 0) + 1 FROM invoices), est.display_number)
  RETURNING id INTO inv_id;
  line_total := 0;
  FOR line IN SELECT * FROM estimate_line_items WHERE estimate_id = estimate_id
    AND (array_length(selected_line_ids, 1) IS NULL OR id = ANY(selected_line_ids))
  LOOP
    INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price, line_total, sort_order)
    VALUES (inv_id, line.description, line.quantity, line.unit, line.unit_price, line.line_total, line.sort_order);
    line_total := line_total + line.line_total;
  END LOOP;
  UPDATE invoices SET subtotal = line_total, total = line_total + (line_total * est.tax_rate / 100) WHERE id = inv_id;
  RETURN inv_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.convert_estimate_to_invoice TO service_role;

-- MISSING RPC: create_estimate_with_lines — called by work-orders.js create-estimate route
CREATE OR REPLACE FUNCTION public.create_estimate_with_lines(estimate_data jsonb, lines jsonb, user_id bigint DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id bigint;
BEGIN
  INSERT INTO estimates (work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, payment_terms, created_by_user_id)
  VALUES (
    (estimate_data->>'work_order_id')::bigint,
    COALESCE(estimate_data->>'status', 'draft'),
    (estimate_data->>'subtotal')::numeric,
    (estimate_data->>'tax_rate')::numeric,
    (estimate_data->>'tax_amount')::numeric,
    (estimate_data->>'total')::numeric,
    (estimate_data->>'cost_total')::numeric,
    COALESCE(estimate_data->>'payment_terms', 'Net 30'),
    user_id
  ) RETURNING id INTO new_id;
  INSERT INTO estimate_line_items (estimate_id, description, quantity, unit, unit_price, cost, line_total, selected, sort_order)
  SELECT new_id, line->>'description', (line->>'quantity')::numeric, line->>'unit',
    (line->>'unit_price')::numeric, (line->>'cost')::numeric, (line->>'line_total')::numeric,
    COALESCE((line->>'selected')::int, 1), COALESCE((line->>'sort_order')::int, 0)
  FROM jsonb_array_elements(lines) AS line;
  RETURN new_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_estimate_with_lines TO service_role;

CREATE OR REPLACE FUNCTION public.create_invoice_with_lines(invoice_data jsonb, lines jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id bigint;
BEGIN
  INSERT INTO invoices (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, due_date, invoice_number, display_number)
  VALUES (
    NULLIF(invoice_data->>'estimate_id','')::bigint,
    (invoice_data->>'work_order_id')::bigint,
    COALESCE(invoice_data->>'status', 'draft'),
    (invoice_data->>'subtotal')::numeric,
    (invoice_data->>'tax_rate')::numeric,
    (invoice_data->>'tax_amount')::numeric,
    (invoice_data->>'total')::numeric,
    (invoice_data->>'cost_total')::numeric,
    NULLIF(invoice_data->>'due_date','')::date,
    (SELECT COALESCE(MAX(invoice_number), 0) + 1 FROM invoices),
    invoice_data->>'display_number'
  ) RETURNING id INTO new_id;
  INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price, line_total, sort_order)
  SELECT new_id, line->>'description', (line->>'quantity')::numeric, line->>'unit',
    (line->>'unit_price')::numeric, (line->>'line_total')::numeric, COALESCE((line->>'sort_order')::int, 0)
  FROM jsonb_array_elements(lines) AS line;
  RETURN new_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_invoice_with_lines TO service_role;

CREATE OR REPLACE FUNCTION public.record_payment(invoice_id bigint, amount numeric, payment_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv RECORD;
  new_status text;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  new_status := inv.status;
  IF amount >= (inv.total - COALESCE(inv.amount_paid, 0)) THEN new_status := 'paid'; END IF;
  UPDATE invoices SET
    amount_paid = COALESCE(amount_paid, 0) + amount,
    status = new_status,
    paid_at = CASE WHEN new_status = 'paid' THEN payment_date ELSE paid_at END,
    updated_at = now()
  WHERE id = invoice_id;
  INSERT INTO audit_logs (entity_type, entity_id, action, before, after, source, user_id)
  VALUES ('invoice', invoice_id, 'payment_received',
    jsonb_build_object('amount_paid', inv.amount_paid, 'status', inv.status),
    jsonb_build_object('amount_paid', COALESCE(inv.amount_paid, 0) + amount, 'status', new_status),
    'web', NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_payment TO service_role;

CREATE OR REPLACE FUNCTION public.void_invoice(invoice_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  UPDATE invoices SET status = 'void', updated_at = now() WHERE id = invoice_id;
  INSERT INTO audit_logs (entity_type, entity_id, action, before, after, source, user_id)
  VALUES ('invoice', invoice_id, 'voided',
    jsonb_build_object('status', inv.status),
    jsonb_build_object('status', 'void'),
    'web', NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.void_invoice TO service_role;

CREATE OR REPLACE FUNCTION public.create_bill_with_lines(bill_data jsonb, lines jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id bigint;
BEGIN
  INSERT INTO bills (vendor_id, job_id, work_order_id, bill_number, status, subtotal, tax_amount, total, due_date, bill_date, created_by_user_id)
  VALUES (
    (bill_data->>'vendor_id')::bigint,
    NULLIF(bill_data->>'job_id','')::bigint,
    NULLIF(bill_data->>'work_order_id','')::bigint,
    bill_data->>'bill_number',
    'draft',
    (bill_data->>'subtotal')::numeric,
    (bill_data->>'tax_amount')::numeric,
    (bill_data->>'total')::numeric,
    NULLIF(bill_data->>'due_date','')::date,
    NULLIF(bill_data->>'bill_date','')::date,
    (bill_data->>'created_by_user_id')::bigint
  ) RETURNING id INTO new_id;
  INSERT INTO bill_lines (bill_id, description, quantity, unit, unit_price, line_total, account_id, sort_order)
  SELECT new_id, line->>'description', (line->>'quantity')::numeric, line->>'unit',
    (line->>'unit_price')::numeric, (line->>'line_total')::numeric,
    NULLIF(line->>'account_id','')::bigint, COALESCE((line->>'sort_order')::int, 0)
  FROM jsonb_array_elements(lines) AS line;
  RETURN new_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_bill_with_lines TO service_role;

CREATE OR REPLACE FUNCTION public.approve_bill(bill_id bigint, user_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bill RECORD;
BEGIN
  SELECT * INTO bill FROM bills WHERE id = bill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  UPDATE bills SET status = 'approved', approved_by_user_id = user_id, approved_at = now(), updated_at = now() WHERE id = bill_id;
  INSERT INTO audit_logs (entity_type, entity_id, action, before, after, source, user_id)
  VALUES ('bill', bill_id, 'approved',
    jsonb_build_object('status', bill.status),
    jsonb_build_object('status', 'approved'),
    'web', user_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_bill TO service_role;

CREATE OR REPLACE FUNCTION public.pay_bill(bill_id bigint, amount numeric, payment_date date, user_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bill RECORD;
  new_status text;
BEGIN
  SELECT * INTO bill FROM bills WHERE id = bill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  new_status := bill.status;
  IF amount >= (bill.total - COALESCE(bill.amount_paid, 0)) THEN new_status := 'paid'; END IF;
  UPDATE bills SET
    amount_paid = COALESCE(amount_paid, 0) + amount,
    status = new_status,
    paid_at = CASE WHEN new_status = 'paid' THEN payment_date ELSE paid_at END,
    updated_at = now()
  WHERE id = bill_id;
  INSERT INTO audit_logs (entity_type, entity_id, action, before, after, source, user_id)
  VALUES ('bill', bill_id, 'payment_made',
    jsonb_build_object('amount_paid', bill.amount_paid, 'status', bill.status),
    jsonb_build_object('amount_paid', COALESCE(bill.amount_paid, 0) + amount, 'status', new_status),
    'web', user_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.pay_bill TO service_role;

-- Make sure audit_logs source constraint allows 'web' (used by RPCs)
ALTER TABLE IF EXISTS audit_logs DROP CONSTRAINT IF EXISTS audit_logs_source_check;
ALTER TABLE IF EXISTS audit_logs ADD CONSTRAINT audit_logs_source_check
  CHECK (source = ANY (ARRAY['user'::text, 'ai'::text, 'stripe'::text, 'plaid'::text, 'system'::text, 'web'::text]));
