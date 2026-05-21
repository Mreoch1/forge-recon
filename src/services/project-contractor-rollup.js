/**
 * F-011: Project contractor/vendor rollup service.
 *
 * For a given job, aggregates approved RFP line items by vendor name
 * to show contract value, then matches bills to show billed-to-date
 * and remaining.
 */
const supabase = require('../db/supabase');

function toNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * Get the contractor rollup for a project.
 * @param {number|string} jobId
 * @returns {Promise<Array>} Array of contractor rollup objects.
 */
async function getProjectContractorRollup(jobId) {
  // 1. Get all awarded RFPs for this job
  const { data: rfps, error: rfpErr } = await supabase
    .from('project_rfps')
    .select('id')
    .eq('job_id', jobId)
    .eq('status', 'awarded');
  if (rfpErr) throw rfpErr;
  const rfpIds = (rfps || []).map(r => r.id);
  if (rfpIds.length === 0) return [];

  // 2. Get approved line items grouped by vendor
  const { data: lineItems, error: liErr } = await supabase
    .from('rfp_line_items')
    .select('vendor, description, total_with_markup')
    .in('rfp_id', rfpIds)
    .eq('approved', true);
  if (liErr) throw liErr;

  // Group by vendor
  const vendorMap = {};
  for (const li of (lineItems || [])) {
    const vName = (li.vendor || '').trim();
    if (!vName) continue;
    if (!vendorMap[vName]) {
      vendorMap[vName] = {
        vendor: vName,
        contract_value: 0,
        description_lines: [],
      };
    }
    vendorMap[vName].contract_value += toNum(li.total_with_markup);
    // Collect unique description lines (up to 3)
    if (li.description && vendorMap[vName].description_lines.length < 3
        && !vendorMap[vName].description_lines.includes(li.description)) {
      vendorMap[vName].description_lines.push(li.description);
    }
  }

  const vendorNames = Object.keys(vendorMap);
  if (vendorNames.length === 0) return [];

  // 3. Try to match vendor names to vendors table
  const { data: vendors, error: vErr } = await supabase
    .from('vendors')
    .select('id, name, email, phone')
    .in('name', vendorNames);
  if (vErr) throw vErr;

  const vendorLookup = {};
  (vendors || []).forEach(v => {
    vendorLookup[v.name.toLowerCase()] = v;
  });

  // 4. Get bills for this job
  const { data: bills, error: bErr } = await supabase
    .from('bills')
    .select('id, bill_number, total, status, bill_date, vendor_id, vendors!left(name)')
    .eq('job_id', jobId)
    .in('status', ['approved', 'paid']);
  if (bErr) throw bErr;

  // Group bills by vendor_id
  const billsByVendor = {};
  (bills || []).forEach(b => {
    const vId = b.vendor_id;
    if (!vId) return;
    if (!billsByVendor[vId]) billsByVendor[vId] = [];
    billsByVendor[vId].push({
      id: b.id,
      bill_number: b.bill_number,
      total: toNum(b.total),
      status: b.status,
      bill_date: b.bill_date,
      vendor_name: b.vendors?.name || null,
    });
  });

  // 5. Build result array
  const result = vendorNames.map(vName => {
    const entry = vendorMap[vName];
    const matched = vendorLookup[vName.toLowerCase()] || null;
    const vId = matched ? matched.id : null;
    const vendorBills = vId ? (billsByVendor[vId] || []) : [];
    const billed = vendorBills.reduce((s, b) => s + b.total, 0);
    const remaining = entry.contract_value - billed;

    let status = 'pending';
    if (billed > entry.contract_value) status = 'over_budget';
    else if (billed >= entry.contract_value && entry.contract_value > 0) status = 'completed';
    else if (billed > 0) status = 'active';

    return {
      vendor: entry.vendor,
      vendor_id: vId,
      contact: matched ? { email: matched.email, phone: matched.phone } : null,
      description_lines: entry.description_lines,
      contract_value: Number(entry.contract_value.toFixed(2)),
      billed: Number(billed.toFixed(2)),
      remaining: Number(remaining.toFixed(2)),
      status,
      bills: vendorBills,
    };
  });

  // Sort by contract_value descending
  result.sort((a, b) => b.contract_value - a.contract_value);

  return result;
}

module.exports = { getProjectContractorRollup };
