const fs = require('fs');
const path = require('path');

const SUMMARY_PATH = path.join(__dirname, '..', '..', 'docs', 'import', 'quickbooks-export-summary.json');

function readDiscoverySummary() {
  try {
    return JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  } catch (error) {
    return {
      generated_at: null,
      quickbooks_exports: {},
      import_sequence: [],
      forge_changes_needed: [],
      read_error: error.message,
    };
  }
}

function money(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '$0.00';
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function exportCards(summary) {
  const exports = summary.quickbooks_exports || {};
  return [
    {
      label: 'Chart of accounts',
      source: 'RECON_ENTERPRISES.csv',
      count: exports.chart_of_accounts?.rows || 0,
      amount: null,
      status: 'Reviewed',
    },
    {
      label: 'Customers',
      source: 'Customers (1).xls',
      count: 1070,
      amount: null,
      status: 'Reviewed',
    },
    {
      label: 'Vendors',
      source: 'Vendors.xls',
      count: 262,
      amount: null,
      status: 'Reviewed',
    },
    {
      label: 'A/R aging',
      source: 'RECON ENTERPRISES_A_R Aging Summary Report.csv',
      count: exports.ar_aging?.rows || 0,
      amount: money(exports.ar_aging?.total),
      status: 'Reconciliation only',
    },
    {
      label: 'A/P aging',
      source: 'RECON ENTERPRISES_A_P Aging Summary Report.csv',
      count: exports.ap_aging?.rows || 0,
      amount: money(exports.ap_aging?.total),
      status: 'Reconciliation only',
    },
    {
      label: 'Invoice PDF sample',
      source: 'Invoices.pdf',
      count: exports.invoice_pdf?.parsed_invoices || 0,
      amount: money(exports.invoice_pdf?.total),
      status: 'Discovery only',
    },
  ];
}

module.exports = {
  SUMMARY_PATH,
  readDiscoverySummary,
  exportCards,
  money,
};
