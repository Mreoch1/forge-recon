const supabase = require('../db/supabase');

const DEFAULT_BILL_MARKUP_PCT = 25;

function money(n) {
  const num = Number(n);
  return Math.round((Number.isFinite(num) ? num : 0) * 100) / 100;
}

function qty(n) {
  const num = Number(n);
  return Number.isFinite(num) && num > 0 ? num : 1;
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function termsDueDate(terms) {
  const match = String(terms || '').match(/(\d+)/);
  if (!match) return null;
  return addDaysIso(parseInt(match[1], 10));
}

function billLineToCustomerLine(line, idx, bill, markupPct) {
  const quantity = qty(line.quantity);
  const cost = money(line.unit_price);
  const customerUnit = money(cost * (1 + markupPct / 100));
  return {
    description: line.description || `Billing item from ${bill.bill_number ? 'bill #' + bill.bill_number : 'vendor bill'}`,
    quantity,
    unit: line.unit || 'ea',
    unit_price: customerUnit,
    cost,
    line_total: money(quantity * customerUnit),
    selected: 1,
    sort_order: idx,
    source_bill_id: bill.id,
    source_bill_line_id: line.id,
  };
}

async function loadBill(billId) {
  const { data: bill, error: billError } = await supabase
    .from('bills')
    .select('id, bill_number, vendor_id, job_id, work_order_id, subtotal, total, status, vendors!left(name)')
    .eq('id', billId)
    .maybeSingle();
  if (billError) throw billError;
  if (!bill) return null;

  const { data: lines, error: linesError } = await supabase
    .from('bill_lines')
    .select('id, description, quantity, unit_price, line_total, sort_order')
    .eq('bill_id', bill.id)
    .order('sort_order', { ascending: true });
  if (linesError) throw linesError;

  return {
    ...bill,
    vendor_name: bill.vendors?.name || null,
    lines: lines || [],
  };
}

async function loadSettings() {
  const { data, error } = await supabase
    .from('company_settings')
    .select('default_tax_rate, default_payment_terms, default_conditions, default_bill_markup_pct')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

async function loadWorkOrder(woId) {
  const { data, error } = await supabase
    .from('work_orders')
    .select('id, display_number, unit_number')
    .eq('id', woId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function existingEstimateForWo(woId) {
  const { data, error } = await supabase
    .from('estimates')
    .select('id, status, tax_rate, payment_terms')
    .eq('work_order_id', woId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function existingInvoiceForEstimate(estimateId) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, status, tax_rate, payment_terms')
    .eq('estimate_id', estimateId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function existingSourceLineIds(table, parentField, parentId, billId) {
  const { data, error } = await supabase
    .from(table)
    .select('source_bill_line_id')
    .eq(parentField, parentId)
    .eq('source_bill_id', billId);
  if (error && error.code !== '42703') throw error;
  return new Set((data || []).map(r => Number(r.source_bill_line_id)).filter(Number.isFinite));
}

async function totalsForEstimate(estimateId, taxRate) {
  const { data, error } = await supabase
    .from('estimate_line_items')
    .select('quantity, cost, line_total')
    .eq('estimate_id', estimateId);
  if (error) throw error;
  const subtotal = money((data || []).reduce((s, r) => s + Number(r.line_total || 0), 0));
  const costTotal = money((data || []).reduce((s, r) => s + (Number(r.cost || 0) * Number(r.quantity || 0)), 0));
  const rate = Number(taxRate) || 0;
  const taxAmount = money(subtotal * rate / 100);
  return { subtotal, tax_amount: taxAmount, total: money(subtotal + taxAmount), cost_total: costTotal };
}

async function totalsForInvoice(invoiceId, taxRate) {
  const { data, error } = await supabase
    .from('invoice_line_items')
    .select('quantity, cost, line_total')
    .eq('invoice_id', invoiceId);
  if (error) throw error;
  const subtotal = money((data || []).reduce((s, r) => s + Number(r.line_total || 0), 0));
  const costTotal = money((data || []).reduce((s, r) => s + (Number(r.cost || 0) * Number(r.quantity || 0)), 0));
  const rate = Number(taxRate) || 0;
  const taxAmount = money(subtotal * rate / 100);
  return { subtotal, tax_amount: taxAmount, total: money(subtotal + taxAmount), cost_total: costTotal };
}

async function ensureEstimate(bill, settings, wo, sourceLines) {
  let estimate = await existingEstimateForWo(bill.work_order_id);
  let created = false;
  const taxRate = Number(settings.default_tax_rate) || 0;
  const terms = settings.default_payment_terms || 'Net 30';

  if (!estimate) {
    const seedTotals = {
      subtotal: money(sourceLines.reduce((s, r) => s + r.line_total, 0)),
      cost_total: money(sourceLines.reduce((s, r) => s + (r.cost * r.quantity), 0)),
    };
    seedTotals.tax_amount = money(seedTotals.subtotal * taxRate / 100);
    seedTotals.total = money(seedTotals.subtotal + seedTotals.tax_amount);

    const { data, error } = await supabase
      .from('estimates')
      .insert({
        work_order_id: bill.work_order_id,
        status: 'draft',
        subtotal: seedTotals.subtotal,
        tax_rate: taxRate,
        tax_amount: seedTotals.tax_amount,
        total: seedTotals.total,
        cost_total: seedTotals.cost_total,
        payment_terms: terms,
        valid_until: addDaysIso(30),
        unit_number: wo?.unit_number || null,
        updated_at: new Date().toISOString(),
      })
      .select('id, status, tax_rate, payment_terms')
      .single();
    if (error) throw error;
    estimate = data;
    created = true;
  }

  if (['new', 'draft'].includes(estimate.status)) {
    const existingLineIds = await existingSourceLineIds('estimate_line_items', 'estimate_id', estimate.id, bill.id);
    const missing = sourceLines.filter(line => !existingLineIds.has(Number(line.source_bill_line_id)));
    if (missing.length) {
      const { error } = await supabase.from('estimate_line_items').insert(missing.map(line => ({
        estimate_id: estimate.id,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        cost: line.cost,
        line_total: line.line_total,
        selected: 1,
        sort_order: line.sort_order,
        source_bill_id: line.source_bill_id,
        source_bill_line_id: line.source_bill_line_id,
      })));
      if (error) throw error;
    }
    const totals = await totalsForEstimate(estimate.id, estimate.tax_rate);
    const { error } = await supabase.from('estimates').update({ ...totals, updated_at: new Date().toISOString() }).eq('id', estimate.id);
    if (error) throw error;
  }

  return { estimate, created };
}

async function ensureInvoice(bill, settings, estimate, sourceLines) {
  let invoice = await existingInvoiceForEstimate(estimate.id);
  let created = false;
  const taxRate = Number(estimate.tax_rate) || Number(settings.default_tax_rate) || 0;
  const terms = estimate.payment_terms || settings.default_payment_terms || 'Net 30';

  if (!invoice) {
    const seedTotals = {
      subtotal: money(sourceLines.reduce((s, r) => s + r.line_total, 0)),
      cost_total: money(sourceLines.reduce((s, r) => s + (r.cost * r.quantity), 0)),
    };
    seedTotals.tax_amount = money(seedTotals.subtotal * taxRate / 100);
    seedTotals.total = money(seedTotals.subtotal + seedTotals.tax_amount);

    const { data, error } = await supabase
      .from('invoices')
      .insert({
        estimate_id: estimate.id,
        work_order_id: bill.work_order_id,
        status: 'draft',
        subtotal: seedTotals.subtotal,
        tax_rate: taxRate,
        tax_amount: seedTotals.tax_amount,
        total: seedTotals.total,
        cost_total: seedTotals.cost_total,
        payment_terms: terms,
        due_date: termsDueDate(terms),
        conditions: settings.default_conditions || null,
        updated_at: new Date().toISOString(),
      })
      .select('id, status, tax_rate, payment_terms')
      .single();
    if (error) throw error;
    invoice = data;
    created = true;
  }

  if (invoice.status === 'draft') {
    const existingLineIds = await existingSourceLineIds('invoice_line_items', 'invoice_id', invoice.id, bill.id);
    const missing = sourceLines.filter(line => !existingLineIds.has(Number(line.source_bill_line_id)));
    if (missing.length) {
      const { error } = await supabase.from('invoice_line_items').insert(missing.map(line => ({
        invoice_id: invoice.id,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        cost: line.cost,
        line_total: line.line_total,
        sort_order: line.sort_order,
        source_bill_id: line.source_bill_id,
        source_bill_line_id: line.source_bill_line_id,
      })));
      if (error) throw error;
    }
    const totals = await totalsForInvoice(invoice.id, invoice.tax_rate);
    const { error } = await supabase.from('invoices').update({ ...totals, updated_at: new Date().toISOString() }).eq('id', invoice.id);
    if (error) throw error;
  }

  return { invoice, created };
}

async function ensureDraftPaperworkForBill({ billId }) {
  const bill = await loadBill(billId);
  if (!bill) return { skipped: true, reason: 'bill_not_found' };
  if (!bill.work_order_id) return { skipped: true, reason: 'no_work_order' };
  if (!bill.lines.length) return { skipped: true, reason: 'no_lines' };

  const [settings, wo] = await Promise.all([
    loadSettings(),
    loadWorkOrder(bill.work_order_id),
  ]);
  const configuredMarkup = Number(settings.default_bill_markup_pct);
  const markupPct = Number.isFinite(configuredMarkup) && configuredMarkup >= 0
    ? configuredMarkup
    : DEFAULT_BILL_MARKUP_PCT;
  const sourceLines = bill.lines.map((line, idx) => billLineToCustomerLine(line, idx, bill, markupPct));
  const estimateResult = await ensureEstimate(bill, settings, wo, sourceLines);
  const invoiceResult = await ensureInvoice(bill, settings, estimateResult.estimate, sourceLines);

  return {
    skipped: false,
    estimate_id: estimateResult.estimate.id,
    estimate_created: estimateResult.created,
    invoice_id: invoiceResult.invoice.id,
    invoice_created: invoiceResult.created,
  };
}

module.exports = {
  ensureDraftPaperworkForBill,
};
