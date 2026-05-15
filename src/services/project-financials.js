/**
 * D-007a Financial Command Panel — project financials service.
 *
 * Aggregates contract, change orders, invoices, payments, RFP commitments,
 * vendor invoices, and bills into a single financial snapshot for the
 * Project Financials command panel shown on the job show page.
 *
 * All Supabase errors are thrown — no silent empty fallbacks.
 */

const supabase = require('../db/supabase');

/**
 * Throws if the Supabase response contains an error.
 */
function throwOnError(result, label) {
  if (result && result.error) {
    result.error.message = `${label}: ${result.error.message}`;
    throw result.error;
  }
  return result;
}

/**
 * Coerce a value to a finite number, defaulting to 0.
 */
function toNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * Aggregate a numeric column from a table filtered by job_id.
 * Returns 0 on empty result set.
 */
async function sumByJobId(table, column, jobId) {
  const result = await supabase
    .from(table)
    .select(`sum:${column}`)
    .eq('job_id', jobId);
  throwOnError(result, `${table}.${column} SUM for job ${jobId}`);
  return toNum(result.data?.[0]?.sum);
}

/**
 * Build the full financials object for a given job.
 *
 * @param {number|string} jobId
 * @returns {Promise<Object>} financials shape
 */
async function getProjectFinancials(jobId) {
  // ── 1. Job contract value ──────────────────────────────────────────
  const { data: jobData, error: jobError } = await supabase
    .from('jobs')
    .select('contract_value')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  const contract_value = toNum(jobData?.contract_value);

  // ── 2. Change orders — split by status ─────────────────────────────
  const { data: approvedCOs, error: approvedCOError } = await supabase
    .from('change_orders')
    .select('customer_amount')
    .eq('job_id', jobId)
    .eq('status', 'approved');
  if (approvedCOError) throw approvedCOError;

  const { data: pendingCOs, error: pendingCOError } = await supabase
    .from('change_orders')
    .select('customer_amount')
    .eq('job_id', jobId)
    .eq('status', 'submitted');
  if (pendingCOError) throw pendingCOError;

  const approved_change_orders = (approvedCOs || []).reduce(
    (s, r) => s + toNum(r.customer_amount), 0
  );
  const pending_change_orders = (pendingCOs || []).reduce(
    (s, r) => s + toNum(r.customer_amount), 0
  );

  // ── 3. Invoices — via work_orders join ─────────────────────────────
  const { data: woData, error: woError } = await supabase
    .from('work_orders')
    .select('id')
    .eq('job_id', jobId);
  if (woError) throw woError;

  let customer_invoiced = 0;
  const woIds = (woData || []).map((r) => r.id);
  if (woIds.length > 0) {
    const { data: invData, error: invError } = await supabase
      .from('invoices')
      .select('total, status')
      .in('work_order_id', woIds);
    if (invError) throw invError;

    customer_invoiced = (invData || [])
      .filter((r) => r.status !== 'voided')
      .reduce((s, r) => s + toNum(r.total), 0);
  }

  // ── 4. Customer payments (project_payments) ────────────────────────
  const customer_paid = await sumByJobId('project_payments', 'amount', jobId);

  // ── 5. RFP commitments — awarded RFPs sum line items ──────────────
  const { data: awardedRfps, error: rfpsError } = await supabase
    .from('project_rfps')
    .select('id')
    .eq('job_id', jobId)
    .eq('status', 'awarded');
  if (rfpsError) throw rfpsError;

  let rfp_committed = 0;
  const rfpIds = (awardedRfps || []).map((r) => r.id);
  if (rfpIds.length > 0) {
    const { data: lineItemData, error: liError } = await supabase
      .from('rfp_line_items')
      .select('total_with_markup')
      .in('rfp_id', rfpIds)
      .eq('approved', true);
    if (liError) throw liError;

    rfp_committed = (lineItemData || []).reduce(
      (s, r) => s + toNum(r.total_with_markup), 0
    );
  }

  // ── 6. Vendor invoices ─────────────────────────────────────────────
  const vendor_billed = await sumByJobId('vendor_invoices', 'amount', jobId);

  // ── 7. Bills — amount_paid ─────────────────────────────────────────
  const total_spent = await sumByJobId('bills', 'amount_paid', jobId);

  // ── Derived values ─────────────────────────────────────────────────
  const revised_contract_value = contract_value + approved_change_orders;
  const customer_outstanding = customer_invoiced - customer_paid;
  const customer_unbilled = revised_contract_value - customer_invoiced;

  // contractor_budget and vendor_committed are not yet tracked in
  // separate tables — set to 0 for now.
  const contractor_budget = 0;
  const vendor_committed = 0;

  // vendor_paid is derived from project_payments or bills linked to
  // vendors. For simplicity in v1, use bills amount_paid as vendor paid
  // (bills represent vendor payments in this system).
  const vendor_paid = total_spent;

  // total_committed = RFP commitments + vendor invoices + change order vendor amounts
  // For v1 we use: rfp_committed + vendor_billed + change_order vendor amounts
  const total_billed = vendor_billed;

  // Total committed: RFPs awarded + anything vendor-invoiced + pending change orders
  const { data: vendorCOs, error: vendorCOError } = await supabase
    .from('change_orders')
    .select('vendor_amount')
    .eq('job_id', jobId)
    .in('status', ['approved', 'submitted']);
  if (vendorCOError) throw vendorCOError;

  const vendorCommitFromCOs = (vendorCOs || []).reduce(
    (s, r) => s + toNum(r.vendor_amount), 0
  );

  const total_committed =
    rfp_committed + vendor_billed + vendorCommitFromCOs;

  // Profit estimates
  const estimated_profit = revised_contract_value - total_committed;
  const realized_profit_to_date = customer_paid - total_spent;

  // ── Discrepancy flags ──────────────────────────────────────────────
  const flags = [];

  // error: total_committed > revised_contract_value
  if (total_committed > revised_contract_value) {
    flags.push({
      severity: 'error',
      message: `Total committed ($${total_committed.toFixed(2)}) exceeds revised contract value ($${revised_contract_value.toFixed(2)}).`,
    });
  }

  // error: customer_paid > customer_invoiced
  if (customer_paid > customer_invoiced) {
    flags.push({
      severity: 'error',
      message: `Customer paid ($${customer_paid.toFixed(2)}) exceeds amount invoiced ($${customer_invoiced.toFixed(2)}).`,
    });
  }

  // error: vendor_paid > vendor_billed
  if (vendor_paid > vendor_billed) {
    flags.push({
      severity: 'error',
      message: `Vendor paid ($${vendor_paid.toFixed(2)}) exceeds vendor billed ($${vendor_billed.toFixed(2)}).`,
    });
  }

  // warn: customer_outstanding > 0
  if (customer_outstanding > 0) {
    flags.push({
      severity: 'warn',
      message: `Customer has an outstanding balance of $${customer_outstanding.toFixed(2)}.`,
    });
  }

  // warn: total_committed / revised_contract_value > 0.85 (over 85% committed)
  if (revised_contract_value > 0) {
    const commitRatio = total_committed / revised_contract_value;
    if (commitRatio > 0.85) {
      flags.push({
        severity: 'warn',
        message: `${(commitRatio * 100).toFixed(1)}% of revised contract value is committed (threshold: 85%).`,
      });
    }
  }

  // warn: customer_unbilled < 0
  if (customer_unbilled < 0) {
    flags.push({
      severity: 'warn',
      message: `Customer unbilled balance is negative ($${customer_unbilled.toFixed(2)}). Invoiced amount exceeds revised contract value.`,
    });
  }

  // info: pending_change_orders > 0
  if (pending_change_orders > 0) {
    flags.push({
      severity: 'info',
      message: `${pending_change_orders > 0 ? 'There ' + (pending_change_orders === 1 ? 'is' : 'are') : ''} ${pending_change_orders > 0 ? pending_change_orders : ''} pending change order${pending_change_orders === 1 ? '' : 's'} worth $${pending_change_orders.toFixed(2)} awaiting approval.`,
    });
  }

  // info: vendor_billed - vendor_paid > 0 (unpaid vendor invoices)
  const vendorUnpaid = vendor_billed - vendor_paid;
  if (vendorUnpaid > 0) {
    flags.push({
      severity: 'info',
      message: `Vendor invoices totaling $${vendorUnpaid.toFixed(2)} are unpaid.`,
    });
  }

  return {
    contract_value: Number(contract_value.toFixed(2)),
    approved_change_orders: Number(approved_change_orders.toFixed(2)),
    pending_change_orders: Number(pending_change_orders.toFixed(2)),
    revised_contract_value: Number(revised_contract_value.toFixed(2)),
    customer_invoiced: Number(customer_invoiced.toFixed(2)),
    customer_paid: Number(customer_paid.toFixed(2)),
    customer_outstanding: Number(customer_outstanding.toFixed(2)),
    customer_unbilled: Number(customer_unbilled.toFixed(2)),
    rfp_committed: Number(rfp_committed.toFixed(2)),
    contractor_budget: Number(contractor_budget.toFixed(2)),
    vendor_committed: Number(vendor_committed.toFixed(2)),
    vendor_billed: Number(vendor_billed.toFixed(2)),
    vendor_paid: Number(vendor_paid.toFixed(2)),
    total_committed: Number(total_committed.toFixed(2)),
    total_billed: Number(total_billed.toFixed(2)),
    total_spent: Number(total_spent.toFixed(2)),
    estimated_profit: Number(estimated_profit.toFixed(2)),
    realized_profit_to_date: Number(realized_profit_to_date.toFixed(2)),
    flags,
  };
}

module.exports = { getProjectFinancials };
