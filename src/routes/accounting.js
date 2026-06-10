/**
 * Accounting module routes (v0.6) - Supabase SDK.
 *
 * All gated by requireAdmin in app.js.
 *
 *   GET  /accounting                       - hub page with KPIs
 *   GET  /accounting/accounts              - chart of accounts list
 *   GET  /accounting/journal               - journal entries list (with lines)
 *   GET  /accounting/journal/:id           - single JE detail
 *   GET  /accounting/reports/trial-balance - real trial balance from journal_lines
 *   GET  /accounting/reports/profit-loss   - real P&L from revenue + expense accounts
 *   GET  /accounting/reports/balance-sheet - real balance sheet from asset/liability/equity
 */

const express = require('express');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const reportPdf = require('../services/accounting-report-pdf');

const router = express.Router();

const bankUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0.00';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '$0.00';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const AGING_RANGE_OPTIONS = [
  { value: 'all', label: 'All dates' },
  { value: 'ytd', label: 'Year to date' },
  { value: '1y', label: 'Last 1 year' },
  { value: '2y', label: 'Last 2 years' },
  { value: '3y', label: 'Last 3 years' },
];

const BANK_STATUS_TABS = [
  { value: 'for_review', label: 'For review' },
  { value: 'categorized', label: 'Categorized' },
  { value: 'excluded', label: 'Excluded' },
];

const BANK_DATE_OPTIONS = [
  { value: 'all', label: 'All dates' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'ytd', label: 'Year to date' },
  { value: '1y', label: 'Last 1 year' },
];

const REPORT_DATE_OPTIONS = [
  { value: 'all', label: 'All dates' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'ytd', label: 'Year to date' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last 1 year' },
  { value: '2y', label: 'Last 2 years' },
  { value: '3y', label: 'Last 3 years' },
];

const FAVORITE_REPORTS = [
  { slug: 'ap-aging-summary', title: 'Accounts payable aging summary', group: 'Payables', type: 'Aging', description: 'Open vendor balances by aging bucket.', href: '/accounting/ap-aging', pdf: '/accounting/ap-aging.pdf' },
  { slug: 'ap-aging-detail', title: 'Accounts payable aging detail', group: 'Payables', type: 'Aging', description: 'Open vendor bills and balances by due date.', href: '/accounting/reports/ap-aging-detail', pdf: '/accounting/reports/ap-aging-detail.pdf' },
  { slug: 'ar-aging-summary', title: 'Accounts receivable aging summary', group: 'Receivables', type: 'Aging', description: 'Open customer balances by aging bucket.', href: '/accounting/ar-aging', pdf: '/accounting/ar-aging.pdf' },
  { slug: 'ar-aging-detail', title: 'Accounts receivable aging detail', group: 'Receivables', type: 'Aging', description: 'Open customer invoices and balances by due date.', href: '/accounting/reports/ar-aging-detail', pdf: '/accounting/reports/ar-aging-detail.pdf' },
  { slug: 'balance-sheet', title: 'Balance Sheet', group: 'Financial statements', type: 'Statement', description: 'Assets, liabilities, equity, and balance check.', href: '/accounting/reports/balance-sheet', pdf: '/accounting/reports/balance-sheet.pdf' },
  { slug: 'bills-applied-payments', title: 'Bills and Applied Payments', group: 'Payables', type: 'Payments', description: 'Bills with paid amounts and remaining balances.', href: '/accounting/reports/bills-applied-payments', pdf: '/accounting/reports/bills-applied-payments.pdf' },
  { slug: 'bill-payment-list', title: 'Bill Payment List', group: 'Payables', type: 'Payments', description: 'Paid vendor bills and payment totals.', href: '/accounting/reports/bill-payment-list', pdf: '/accounting/reports/bill-payment-list.pdf' },
  { slug: 'deposit-detail', title: 'Deposit Detail', group: 'Banking', type: 'Deposits', description: 'Received bank transactions and customer deposits.', href: '/accounting/reports/deposit-detail', pdf: '/accounting/reports/deposit-detail.pdf' },
  { slug: 'invoices-received-payments', title: 'Invoices and Received Payments', group: 'Receivables', type: 'Payments', description: 'Invoices with customer payments and open balances.', href: '/accounting/reports/invoices-received-payments', pdf: '/accounting/reports/invoices-received-payments.pdf' },
  { slug: 'profit-loss', title: 'Profit and Loss', group: 'Financial statements', type: 'Statement', description: 'Revenue, expenses, and net income.', href: '/accounting/reports/profit-loss', pdf: '/accounting/reports/profit-loss.pdf' },
  { slug: 'paycheck-history', title: 'Paycheck History', group: 'Payroll', type: 'Payroll', description: 'Payroll run checks and employee net pay.', href: '/accounting/reports/paycheck-history', pdf: '/accounting/reports/paycheck-history.pdf' },
  { slug: 'payroll-summary-by-employee', title: 'Payroll Summary by Employee', group: 'Payroll', type: 'Payroll', description: 'Gross pay, taxes, deductions, and net pay by employee.', href: '/accounting/reports/payroll-summary-by-employee', pdf: '/accounting/reports/payroll-summary-by-employee.pdf' },
  { slug: 'payroll-details', title: 'Payroll Details', group: 'Payroll', type: 'Payroll', description: 'Payroll line detail by employee, project, and work order.', href: '/accounting/reports/payroll-details', pdf: '/accounting/reports/payroll-details.pdf' },
  { slug: 'payroll-summary', title: 'Payroll Summary', group: 'Payroll', type: 'Payroll', description: 'Payroll totals by pay date and payroll run.', href: '/accounting/reports/payroll-summary', pdf: '/accounting/reports/payroll-summary.pdf' },
  { slug: 'payroll-tax-liability', title: 'Payroll Tax Liability', group: 'Payroll', type: 'Tax', description: 'Employer tax liability by payroll run.', href: '/accounting/reports/payroll-tax-liability', pdf: '/accounting/reports/payroll-tax-liability.pdf' },
  { slug: 'total-payroll-cost', title: 'Total Payroll Cost', group: 'Payroll', type: 'Payroll', description: 'Gross pay plus employer taxes by employee.', href: '/accounting/reports/total-payroll-cost', pdf: '/accounting/reports/total-payroll-cost.pdf' },
  { slug: 'payroll-tax-wage-summary', title: 'Payroll Tax and Wage Summary', group: 'Payroll', type: 'Tax', description: 'Taxable wages and payroll tax summary.', href: '/accounting/reports/payroll-tax-wage-summary', pdf: '/accounting/reports/payroll-tax-wage-summary.pdf' },
  { slug: 'unpaid-bills', title: 'Unpaid Bills', group: 'Payables', type: 'Open balance', description: 'Unpaid and partially paid vendor bills.', href: '/accounting/reports/unpaid-bills', pdf: '/accounting/reports/unpaid-bills.pdf' },
  { slug: 'vendor-balance-summary', title: 'Vendor Balance Summary', group: 'Payables', type: 'Vendor balance', description: 'Open balances summarized by vendor.', href: '/accounting/reports/vendor-balance-summary', pdf: '/accounting/reports/vendor-balance-summary.pdf' },
  { slug: 'vendor-balance-detail', title: 'Vendor Balance Detail', group: 'Payables', type: 'Vendor balance', description: 'Open vendor balances by bill.', href: '/accounting/reports/vendor-balance-detail', pdf: '/accounting/reports/vendor-balance-detail.pdf' },
];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateOnly(value) {
  if (!value) return null;
  const parts = String(value).slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return null;
  return startOfDay(d);
}

function ymd(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function agingRange(rawValue, now = new Date()) {
  const value = AGING_RANGE_OPTIONS.some(o => o.value === rawValue) ? rawValue : 'all';
  const today = startOfDay(now);
  let start = null;
  if (value === 'ytd') {
    start = new Date(today.getFullYear(), 0, 1);
  } else if (/^\d+y$/.test(value)) {
    const years = Number(value.slice(0, -1));
    start = new Date(today);
    start.setFullYear(start.getFullYear() - years);
  }
  const option = AGING_RANGE_OPTIONS.find(o => o.value === value);
  return {
    value,
    label: option ? option.label : 'All dates',
    start,
    end: today,
    startYmd: ymd(start),
    endYmd: ymd(today),
  };
}

function reportDateRange(rawValue, now = new Date()) {
  const value = REPORT_DATE_OPTIONS.some(o => o.value === rawValue) ? rawValue : 'ytd';
  const today = startOfDay(now);
  let start = null;
  if (value === 'mtd') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (value === 'ytd') {
    start = new Date(today.getFullYear(), 0, 1);
  } else if (value === '30d' || value === '90d') {
    start = new Date(today);
    start.setDate(start.getDate() - Number(value.slice(0, -1)));
  } else if (/^\d+y$/.test(value)) {
    start = new Date(today);
    start.setFullYear(start.getFullYear() - Number(value.slice(0, -1)));
  }
  const option = REPORT_DATE_OPTIONS.find(o => o.value === value);
  return {
    value,
    label: option ? option.label : 'Year to date',
    start,
    end: today,
    startYmd: ymd(start),
    endYmd: ymd(today),
  };
}

function inReportRange(value, range) {
  if (!range || range.value === 'all') return true;
  const d = dateOnly(value);
  if (!d) return false;
  return (!range.start || d >= range.start) && (!range.end || d <= range.end);
}

function cleanQuery(value) {
  return String(value || '').trim();
}

function includesQuery(row, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return Object.values(row).some(value => String(value == null ? '' : value).toLowerCase().includes(needle));
}

function numberValue(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function getFavoriteReport(slug) {
  return FAVORITE_REPORTS.find(r => r.slug === slug) || null;
}

function inAgingRange(value, range) {
  if (!range || range.value === 'all') return true;
  const d = dateOnly(value);
  if (!d) return false;
  return (!range.start || d >= range.start) && (!range.end || d <= range.end);
}

function logAccountingSetupWarning(route, error) {
  console.warn(`[accounting] ${route} unavailable; rendering empty state: ${error.message || error.code || error}`);
}

async function getCompany() {
  const { data, error } = await supabase.from('company_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data || {};
}

function sendPdf(res, filename, report) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  reportPdf.generateReportPDF(report, res);
}

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// Helper: sum debit for a JE id by fetching its lines and reducing in JS.
async function totalDebitsForEntry(jeId) {
  const { data, error } = await supabase
    .from('journal_lines')
    .select('debit')
    .eq('journal_entry_id', jeId);
  if (error) throw error;
  return (data || []).reduce((s, r) => s + Number(r.debit || 0), 0);
}

// --- hub ---

router.get('/', async (req, res) => {
  res.render('accounting/index', {
    title: 'Accounting', activeNav: 'accounting',
    accountsCount: 0,
    jeCount: 0,
    billCount: 0,
    vendorCount: 0,
    recentEntries: [],
    favoriteReports: FAVORITE_REPORTS,
  });
});

function bankDateRange(rawValue, now = new Date()) {
  const value = BANK_DATE_OPTIONS.some(o => o.value === rawValue) ? rawValue : 'all';
  const today = startOfDay(now);
  let start = null;
  if (value === '30d' || value === '90d') {
    start = new Date(today);
    start.setDate(start.getDate() - Number(value.slice(0, -1)));
  } else if (value === 'ytd') {
    start = new Date(today.getFullYear(), 0, 1);
  } else if (value === '1y') {
    start = new Date(today);
    start.setFullYear(start.getFullYear() - 1);
  }
  return { value, startYmd: ymd(start), endYmd: ymd(today) };
}

function normalizeBankStatus(value) {
  return BANK_STATUS_TABS.some(tab => tab.value === value) ? value : 'for_review';
}

function bankTransactionMatchesSearch(tx, q) {
  if (!q) return true;
  const haystack = [
    tx.transaction_date,
    tx.bank_detail,
    tx.payee,
    tx.memo,
    tx.accounts && tx.accounts.code,
    tx.accounts && tx.accounts.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function bankActionLabel(tx) {
  if (tx.match_status === 'categorized') return 'View';
  if (tx.match_status === 'excluded') return 'Restore';
  return tx.account_id ? 'Match' : 'Add';
}

function normalizeImportHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseMoney(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = String(value).trim();
  if (!text || text === '-') return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  text = text.replace(/[()$,]/g, '').replace(/^\+/, '').trim();
  const num = Number(text);
  if (!Number.isFinite(num)) return 0;
  return negative ? -Math.abs(num) : num;
}

function parseImportDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return ymd(value);
  if (typeof value === 'object' && value.result) return parseImportDate(value.result);
  const text = String(value).trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const us = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const year = us[3].length === 2 ? Number(`20${us[3]}`) : Number(us[3]);
    return `${year}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : ymd(parsed);
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return ymd(value);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
    if (value.text) return String(value.text);
    if (value.result != null) return cellText(value.result);
    if (value.hyperlink && value.text) return String(value.text);
  }
  return String(value);
}

function findColumn(headerMap, names) {
  for (const name of names) {
    const key = normalizeImportHeader(name);
    if (headerMap.has(key)) return headerMap.get(key);
  }
  return -1;
}

function normalizeImportedBankRows(rawRows, accountName, filename) {
  const headerRowIndex = rawRows.findIndex(row => {
    const headers = row.map(normalizeImportHeader);
    const hasDate = headers.some(h => ['date', 'transactiondate', 'postingdate', 'postdate'].includes(h));
    const hasAmount = headers.some(h => ['amount', 'spent', 'received', 'withdrawal', 'withdrawals', 'debit', 'credit', 'deposit', 'deposits', 'moneyout', 'moneyin'].includes(h));
    return hasDate && hasAmount;
  });
  if (headerRowIndex < 0) {
    throw new Error('Could not find a transaction header row. Expected Date plus Amount, Spent, or Received columns.');
  }

  const headerMap = new Map();
  rawRows[headerRowIndex].forEach((header, index) => {
    const key = normalizeImportHeader(header);
    if (key && !headerMap.has(key)) headerMap.set(key, index);
  });

  const dateCol = findColumn(headerMap, ['date', 'transaction date', 'posting date', 'post date']);
  const detailCol = findColumn(headerMap, ['bank detail', 'description', 'memo', 'transaction description', 'transaction', 'details']);
  const payeeCol = findColumn(headerMap, ['payee', 'name', 'vendor', 'customer']);
  const spentCol = findColumn(headerMap, ['spent', 'withdrawal', 'withdrawals', 'debit', 'payment', 'charge', 'money out']);
  const receivedCol = findColumn(headerMap, ['received', 'deposit', 'deposits', 'credit', 'money in']);
  const amountCol = findColumn(headerMap, ['amount']);
  const checkCol = findColumn(headerMap, ['check or slip #', 'check number', 'check no', 'check #', 'check']);
  const accountCol = findColumn(headerMap, ['account', 'account name', 'bank account']);

  if (dateCol < 0 || (amountCol < 0 && spentCol < 0 && receivedCol < 0)) {
    throw new Error('Could not map the bank export columns. Expected Date and either Amount or Spent/Received.');
  }

  const imported = [];
  for (const row of rawRows.slice(headerRowIndex + 1)) {
    if (!row || row.every(value => !String(value || '').trim())) continue;
    const transactionDate = parseImportDate(row[dateCol]);
    if (!transactionDate) continue;

    let spent = spentCol >= 0 ? Math.abs(parseMoney(row[spentCol])) : 0;
    let received = receivedCol >= 0 ? Math.abs(parseMoney(row[receivedCol])) : 0;
    if (amountCol >= 0 && !spent && !received) {
      const amount = parseMoney(row[amountCol]);
      if (amount < 0) spent = Math.abs(amount);
      else received = amount;
    }
    if (!spent && !received) continue;

    const detail = detailCol >= 0 ? cellText(row[detailCol]).trim() : '';
    const payee = payeeCol >= 0 ? cellText(row[payeeCol]).trim() : '';
    const checkNumber = checkCol >= 0 ? cellText(row[checkCol]).trim() : '';
    const rowAccount = accountCol >= 0 ? cellText(row[accountCol]).trim() : '';
    const memoParts = [];
    if (checkNumber) memoParts.push(`Check ${checkNumber}`);
    if (filename) memoParts.push(`Imported from ${filename}`);

    imported.push({
      account_name: rowAccount || accountName || 'Checking',
      transaction_date: transactionDate,
      bank_detail: detail || payee || 'Imported bank transaction',
      payee: payee || null,
      match_status: 'for_review',
      spent: Number(spent.toFixed(2)),
      received: Number(received.toFixed(2)),
      memo: memoParts.join(' | ') || null,
    });
  }

  return imported;
}

async function parseBankUpload(file, accountName) {
  if (!file || !file.buffer) throw new Error('Choose a Chase or QuickBooks bank transaction file first.');
  const ext = path.extname(file.originalname || '').toLowerCase();
  const workbook = new ExcelJS.Workbook();
  let rows = [];
  if (ext === '.csv') {
    const worksheet = await workbook.csv.readBuffer(file.buffer);
    worksheet.eachRow({ includeEmpty: false }, row => {
      rows.push(row.values.slice(1).map(cellText));
    });
  } else if (ext === '.xlsx') {
    await workbook.xlsx.load(file.buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error('The workbook does not contain any sheets.');
    worksheet.eachRow({ includeEmpty: false }, row => {
      rows.push(row.values.slice(1).map(cellText));
    });
  } else {
    throw new Error('Upload a .csv or .xlsx bank transaction export.');
  }
  return normalizeImportedBankRows(rows, accountName, file.originalname || 'bank export');
}

function bankDuplicateKey(row) {
  return [
    row.account_name,
    row.transaction_date,
    row.bank_detail,
    row.payee || '',
    Number(row.spent || 0).toFixed(2),
    Number(row.received || 0).toFixed(2),
  ].join('|').toLowerCase();
}

async function insertBankImportRows(rows) {
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const startDate = rows.reduce((min, row) => !min || row.transaction_date < min ? row.transaction_date : min, null);
  const endDate = rows.reduce((max, row) => !max || row.transaction_date > max ? row.transaction_date : max, null);
  const { data: existing, error: existingErr } = await supabase
    .from('bank_transactions')
    .select('account_name, transaction_date, bank_detail, payee, spent, received')
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate)
    .limit(5000);
  if (existingErr) throw existingErr;

  const seen = new Set((existing || []).map(bankDuplicateKey));
  const toInsert = [];
  for (const row of rows) {
    const key = bankDuplicateKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push(row);
  }
  if (!toInsert.length) return { inserted: 0, skipped: rows.length };

  const { error } = await supabase.from('bank_transactions').insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped: rows.length - toInsert.length };
}

async function loadBankTransactions(req) {
  const status = normalizeBankStatus(req.query.status);
  const dateRange = bankDateRange(req.query.date_range);
  const txType = ['all', 'spent', 'received'].includes(req.query.type) ? req.query.type : 'all';
  const q = String(req.query.q || '').trim();

  let query = supabase
    .from('bank_transactions')
    .select('*, accounts:account_id(id, code, name, type)')
    .eq('match_status', status)
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);

  if (dateRange.startYmd) query = query.gte('transaction_date', dateRange.startYmd);
  if (txType === 'spent') query = query.gt('spent', 0);
  if (txType === 'received') query = query.gt('received', 0);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data || []).filter(tx => bankTransactionMatchesSearch(tx, q));
  const accountMap = new Map();
  rows.forEach(tx => {
    const key = tx.account_name || 'Unassigned account';
    const current = accountMap.get(key) || {
      name: key,
      forReview: 0,
      categorized: 0,
      excluded: 0,
      balance: 0,
    };
    current[tx.match_status === 'for_review' ? 'forReview' : tx.match_status] += 1;
    current.balance += Number(tx.received || 0) - Number(tx.spent || 0);
    accountMap.set(key, current);
  });

  const totals = rows.reduce((sum, tx) => {
    sum.spent += Number(tx.spent || 0);
    sum.received += Number(tx.received || 0);
    return sum;
  }, { spent: 0, received: 0 });

  return {
    rows,
    status,
    dateRange,
    txType,
    q,
    accountCards: Array.from(accountMap.values()),
    totals,
  };
}

router.get('/bank-transactions', async (req, res) => {
  let data = {
    rows: [],
    status: normalizeBankStatus(req.query.status),
    dateRange: bankDateRange(req.query.date_range),
    txType: ['all', 'spent', 'received'].includes(req.query.type) ? req.query.type : 'all',
    q: String(req.query.q || '').trim(),
    accountCards: [],
    totals: { spent: 0, received: 0 },
  };
  let warning = null;

  try {
    data = await loadBankTransactions(req);
  } catch (error) {
    logAccountingSetupWarning('/bank-transactions', error);
    warning = 'Bank transaction table is not ready yet. Run the latest database migration, then refresh this page.';
  }

  res.render('accounting/bank-transactions', {
    title: 'Bank transactions',
    activeNav: 'accounting',
    ...data,
    warning,
    statusTabs: BANK_STATUS_TABS,
    dateOptions: BANK_DATE_OPTIONS,
    money,
    bankActionLabel,
  });
});

router.post('/bank-transactions/import', bankUpload.single('bank_file'), async (req, res) => {
  try {
    const accountName = String(req.body.account_name || '').trim() || 'Checking';
    const importedRows = await parseBankUpload(req.file, accountName);
    const result = await insertBankImportRows(importedRows);
    if (!importedRows.length) {
      setFlash(req, 'error', 'No usable bank transactions were found in that file.');
    } else if (result.inserted) {
      const skipped = result.skipped ? ` ${result.skipped} duplicate row(s) skipped.` : '';
      setFlash(req, 'success', `Imported ${result.inserted} bank transaction(s).${skipped}`);
    } else {
      setFlash(req, 'success', `No new transactions imported. ${result.skipped} duplicate row(s) were already in Forge.`);
    }
  } catch (error) {
    setFlash(req, 'error', error.message || 'Bank transaction import failed.');
  }
  res.redirect('/accounting/bank-transactions?status=for_review');
});

async function loadPayrollOverview() {
  const empty = {
    ready: false,
    settings: null,
    employees: [],
    users: [],
    runs: [],
    employeeCount: 0,
    activeCount: 0,
    nextPayDate: null,
    latestRun: null,
    error: null,
  };

  try {
    const [
      { data: settings, error: settingsErr },
      { data: employees, error: employeeErr },
      { data: users, error: usersErr },
      { data: runs, error: runsErr },
    ] = await Promise.all([
      supabase.from('payroll_settings').select('*').eq('id', 1).maybeSingle(),
      supabase
        .from('payroll_employees')
        .select('id, user_id, display_name, email, role_title, status, pay_type, pay_rate_amount, pay_rate_period, pay_method, pay_schedule, imported_at')
        .order('display_name', { ascending: true })
        .limit(250),
      supabase
        .from('users')
        .select('id, name, email, role')
        .in('role', ['admin', 'manager', 'worker'])
        .order('name', { ascending: true })
        .limit(250),
      supabase
        .from('payroll_runs')
        .select('id, source, pay_period_start, pay_period_end, pay_date, status, gross_pay, employer_taxes, deductions, net_pay')
        .order('pay_date', { ascending: false })
        .limit(20),
    ]);
    if (settingsErr) throw settingsErr;
    if (employeeErr) throw employeeErr;
    if (usersErr) throw usersErr;
    if (runsErr) throw runsErr;

    const roster = employees || [];
    const payrollRuns = runs || [];
    return {
      ready: true,
      settings: settings || null,
      employees: roster,
      users: users || [],
      runs: payrollRuns,
      employeeCount: roster.length,
      activeCount: roster.filter(e => e.status === 'active').length,
      nextPayDate: settings?.next_pay_date || null,
      latestRun: payrollRuns[0] || null,
      error: null,
    };
  } catch (error) {
    return { ...empty, error: error.message || String(error) };
  }
}

router.get('/payroll', async (req, res) => {
  const payroll = await loadPayrollOverview();
  res.render('accounting/payroll', {
    title: 'Payroll',
    activeNav: 'accounting',
    payroll,
    employeeForm: {},
    money: money,
  });
});

function cleanOptionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function cleanPayrollEmployeeInput(body) {
  const displayName = cleanOptionalText(body.display_name);
  const email = cleanOptionalText(body.email);
  const roleTitle = cleanOptionalText(body.role_title);
  const payMethod = cleanOptionalText(body.pay_method);
  const paySchedule = cleanOptionalText(body.pay_schedule);
  const userId = Number.parseInt(body.user_id, 10);
  const rawPayRate = String(body.pay_rate_amount || '').replace(/[$,]/g, '').trim();
  const payRate = rawPayRate ? Number(rawPayRate) : null;
  const status = ['active', 'inactive', 'terminated'].includes(body.status) ? body.status : 'active';
  const payType = ['salary', 'hourly', 'contract', 'other'].includes(body.pay_type) ? body.pay_type : 'salary';
  const payRatePeriod = ['year', 'hour', 'day', 'pay_period', 'other'].includes(body.pay_rate_period) ? body.pay_rate_period : null;

  const errors = [];
  if (!displayName) errors.push('Employee name is required.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email address is not valid.');
  if (rawPayRate && (!Number.isFinite(payRate) || payRate < 0)) errors.push('Pay rate must be a positive number.');
  if (payRate != null && !payRatePeriod) errors.push('Choose a pay rate period.');

  return {
    data: {
      user_id: Number.isFinite(userId) && userId > 0 ? userId : null,
      display_name: displayName,
      email,
      role_title: roleTitle,
      status,
      pay_type: payType,
      pay_rate_amount: payRate,
      pay_rate_period: payRate != null ? payRatePeriod : null,
      pay_method: payMethod,
      pay_schedule: paySchedule,
      imported_from: 'manual',
      imported_at: new Date().toISOString(),
      metadata: { entry: 'manual' },
    },
    errors,
  };
}

router.post('/payroll/employees', async (req, res) => {
  const { data, errors } = cleanPayrollEmployeeInput(req.body || {});
  if (errors.length) {
    const payroll = await loadPayrollOverview();
    return res.status(400).render('accounting/payroll', {
      title: 'Payroll',
      activeNav: 'accounting',
      payroll,
      employeeForm: req.body || {},
      employeeError: errors.join(' '),
      money: money,
    });
  }

  const { error } = await supabase.from('payroll_employees').insert(data);
  if (error) {
    const payroll = await loadPayrollOverview();
    return res.status(400).render('accounting/payroll', {
      title: 'Payroll',
      activeNav: 'accounting',
      payroll,
      employeeForm: req.body || {},
      employeeError: `Employee could not be saved: ${error.message}`,
      money: money,
    });
  }

  setFlash(req, 'success', `Payroll employee "${data.display_name}" added.`);
  res.redirect('/accounting/payroll');
});

router.post('/payroll/employees/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    setFlash(req, 'error', 'Payroll employee not found.');
    return res.redirect('/accounting/payroll');
  }

  const { data, errors } = cleanPayrollEmployeeInput(req.body || {});
  if (errors.length) {
    setFlash(req, 'error', errors.join(' '));
    return res.redirect('/accounting/payroll');
  }

  const update = {
    user_id: data.user_id,
    display_name: data.display_name,
    email: data.email,
    role_title: data.role_title,
    status: data.status,
    pay_type: data.pay_type,
    pay_rate_amount: data.pay_rate_amount,
    pay_rate_period: data.pay_rate_period,
    pay_method: data.pay_method,
    pay_schedule: data.pay_schedule,
    imported_from: data.imported_from,
    metadata: { entry: 'manual_update' },
  };

  const { error } = await supabase.from('payroll_employees').update(update).eq('id', id);
  if (error) {
    setFlash(req, 'error', `Payroll employee could not be updated: ${error.message}`);
    return res.redirect('/accounting/payroll');
  }

  setFlash(req, 'success', `Payroll employee "${data.display_name}" updated.`);
  res.redirect('/accounting/payroll');
});

router.post('/payroll/employees/:id/deactivate', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    setFlash(req, 'error', 'Payroll employee not found.');
    return res.redirect('/accounting/payroll');
  }

  const { error } = await supabase
    .from('payroll_employees')
    .update({ status: 'inactive', metadata: { entry: 'manual_deactivate' } })
    .eq('id', id);
  if (error) {
    setFlash(req, 'error', `Payroll employee could not be deactivated: ${error.message}`);
    return res.redirect('/accounting/payroll');
  }

  setFlash(req, 'success', 'Payroll employee deactivated.');
  res.redirect('/accounting/payroll');
});

// --- chart of accounts ---

async function loadAccounts() {
  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('*')
    .order('code', { ascending: true });
  if (error) throw error;

  const grouped = { asset: [], liability: [], equity: [], revenue: [], expense: [] };
  (accounts || []).forEach(a => { (grouped[a.type] = grouped[a.type] || []).push(a); });
  return { accounts: accounts || [], grouped };
}

router.get('/accounts', async (req, res) => {
  let data = { accounts: [], grouped: { asset: [], liability: [], equity: [], revenue: [], expense: [] } };
  try {
    data = await loadAccounts();
  } catch (error) {
    logAccountingSetupWarning('/accounts', error);
  }

  res.render('accounting/accounts', {
    title: 'Chart of accounts', activeNav: 'accounting',
    ...data,
  });
});

router.get('/accounts.pdf', async (req, res) => {
  const [{ accounts }, company] = await Promise.all([loadAccounts(), getCompany()]);
  sendPdf(res, 'chart-of-accounts.pdf', {
    title: 'Chart of accounts',
    company,
    summary: [
      { label: 'Accounts', value: String(accounts.length) },
      { label: 'Active', value: String(accounts.filter(a => a.active).length) },
    ],
    columns: [
      { key: 'code', label: 'Code', width: 1 },
      { key: 'name', label: 'Name', width: 3 },
      { key: 'type', label: 'Type', width: 1.2 },
      { key: 'active', label: 'Status', width: 1, value: r => r.active ? 'Active' : 'Inactive' },
    ],
    rows: accounts,
  });
});

// --- journal ---

async function loadJournalEntries(limit = 100) {
  const { data: rawEntries, error } = await supabase
    .from('journal_entries')
    .select('*, users:created_by_user_id ( name )')
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const entries = [];
  for (const je of (rawEntries || [])) {
    const total_debits = await totalDebitsForEntry(je.id);
    const { users, ...rest } = je;
    entries.push({
      ...rest,
      created_by_name: users?.name || null,
      total_debits,
    });
  }
  return entries;
}

router.get('/journal', async (req, res) => {
  let entries = [];
  try {
    entries = await loadJournalEntries();
  } catch (error) {
    logAccountingSetupWarning('/journal', error);
  }
  res.render('accounting/journal', {
    title: 'Journal entries', activeNav: 'accounting',
    entries,
  });
});

router.get('/journal.pdf', async (req, res) => {
  const [entries, company] = await Promise.all([loadJournalEntries(250), getCompany()]);
  sendPdf(res, 'journal-entries.pdf', {
    title: 'Journal entries',
    company,
    summary: [
      { label: 'Entries', value: String(entries.length) },
      { label: 'Total posted', value: reportPdf.money(entries.reduce((s, e) => s + Number(e.total_debits || 0), 0)) },
    ],
    columns: [
      { key: 'entry_date', label: 'Date', width: 1.1 },
      { key: 'description', label: 'Description', width: 3 },
      { key: 'source_type', label: 'Source', width: 1.2, value: e => e.source_type ? `${e.source_type} #${e.source_id}` : '-' },
      { key: 'created_by_name', label: 'By', width: 1.2, value: e => e.created_by_name || '-' },
      { key: 'total_debits', label: 'Amount', width: 1, align: 'right', value: e => reportPdf.money(e.total_debits) },
    ],
    rows: entries,
  });
});

async function loadJournalEntry(id) {
  const { data: raw, error: entryErr } = await supabase
    .from('journal_entries')
    .select('*, users:created_by_user_id ( name )')
    .eq('id', id)
    .maybeSingle();
  if (entryErr) throw entryErr;
  if (!raw) return null;
  const { users, ...rest } = raw;
  const entry = { ...rest, created_by_name: users?.name || null };

  const { data: rawLines, error: linesErr } = await supabase
    .from('journal_lines')
    .select('*, accounts!inner ( code, name, type )')
    .eq('journal_entry_id', id)
    .order('id', { ascending: true });
  if (linesErr) throw linesErr;

  const lines = (rawLines || []).map(l => {
    const { accounts: acct, ...lineRest } = l;
    return {
      ...lineRest,
      account_code: acct?.code,
      account_name: acct?.name,
      account_type: acct?.type,
    };
  });
  return { entry, lines };
}

router.get('/journal/:id.pdf', async (req, res) => {
  const [data, company] = await Promise.all([loadJournalEntry(req.params.id), getCompany()]);
  if (!data) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Journal entry not found.' });
  const { entry, lines } = data;
  sendPdf(res, `journal-${entry.id}.pdf`, {
    title: `Journal entry #${entry.id}`,
    subtitle: `${entry.entry_date || ''} ${entry.description || ''}`.trim(),
    company,
    summary: [
      { label: 'Source', value: entry.source_type ? `${entry.source_type} #${entry.source_id}` : '-' },
      { label: 'Posted by', value: entry.created_by_name || '-' },
      { label: 'Debits', value: reportPdf.money(lines.reduce((s, l) => s + Number(l.debit || 0), 0)) },
      { label: 'Credits', value: reportPdf.money(lines.reduce((s, l) => s + Number(l.credit || 0), 0)) },
    ],
    columns: [
      { key: 'account_code', label: 'Code', width: 1 },
      { key: 'account_name', label: 'Account', width: 3 },
      { key: 'account_type', label: 'Type', width: 1.2 },
      { key: 'debit', label: 'Debit', width: 1, align: 'right', value: l => Number(l.debit || 0) ? reportPdf.money(l.debit) : '' },
      { key: 'credit', label: 'Credit', width: 1, align: 'right', value: l => Number(l.credit || 0) ? reportPdf.money(l.credit) : '' },
    ],
    rows: lines,
  });
});

router.get('/journal/:id', async (req, res) => {
  const data = await loadJournalEntry(req.params.id);
  if (!data) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Journal entry not found.' });
  }

  res.render('accounting/journal-detail', {
    title: `Journal #${data.entry.id}`, activeNav: 'accounting',
    ...data,
  });
});

// --- reports ---

async function computeTrialBalance(range = null) {
  const [{ data: accounts, error: aErr }, { data: lines, error: lErr }] = await Promise.all([
    supabase.from('accounts').select('id, code, name, type').eq('active', true).order('code', { ascending: true }),
    supabase.from('journal_lines').select('account_id, debit, credit, journal_entries!inner(entry_date)'),
  ]);
  if (aErr) throw aErr;
  if (lErr) throw lErr;

  const totals = {};
  (lines || []).filter(l => inReportRange(l.journal_entries?.entry_date, range)).forEach(l => {
    const aid = l.account_id;
    if (!totals[aid]) totals[aid] = { debits: 0, credits: 0 };
    totals[aid].debits += Number(l.debit || 0);
    totals[aid].credits += Number(l.credit || 0);
  });

  return (accounts || []).map(a => {
    const t = totals[a.id] || { debits: 0, credits: 0 };
    return {
      id: a.id, code: a.code, name: a.name, type: a.type,
      total_debits: t.debits,
      total_credits: t.credits,
      balance: t.debits - t.credits,
    };
  });
}

router.get('/reports/trial-balance', async (req, res) => {
  const filters = reportFilters(req);
  let rows = [];
  try {
    rows = await computeTrialBalance(filters.range);
  } catch (error) {
    logAccountingSetupWarning('/reports/trial-balance', error);
  }
  let totalDr = 0, totalCr = 0;
  rows.forEach(r => {
    if (r.balance > 0) totalDr += r.balance;
    else if (r.balance < 0) totalCr += -r.balance;
  });
  res.render('accounting/reports/trial-balance', {
    title: 'Trial balance', activeNav: 'accounting',
    rows, totalDr, totalCr, fmt, range: filters.range, rangeOptions: REPORT_DATE_OPTIONS,
  });
});

router.get('/reports/trial-balance.pdf', async (req, res) => {
  const filters = reportFilters(req);
  const [rows, company] = await Promise.all([computeTrialBalance(filters.range), getCompany()]);
  let totalDr = 0, totalCr = 0;
  rows.forEach(r => {
    if (r.balance > 0) totalDr += r.balance;
    else if (r.balance < 0) totalCr += -r.balance;
  });
  sendPdf(res, 'trial-balance.pdf', {
    title: 'Trial balance',
    company,
    summary: [
      { label: 'Debit total', value: reportPdf.money(totalDr) },
      { label: 'Credit total', value: reportPdf.money(totalCr) },
      { label: 'Range', value: filters.range.label },
      { label: 'Status', value: Math.abs(totalDr - totalCr) < 0.01 ? 'Balanced' : 'Unbalanced', color: Math.abs(totalDr - totalCr) < 0.01 ? '#166534' : '#c0202b' },
    ],
    columns: [
      { key: 'code', label: 'Code', width: 1 },
      { key: 'name', label: 'Account', width: 3 },
      { key: 'type', label: 'Type', width: 1.2 },
      { key: 'debit', label: 'Debit', width: 1, align: 'right', value: r => r.balance > 0 ? reportPdf.money(r.balance) : '' },
      { key: 'credit', label: 'Credit', width: 1, align: 'right', value: r => r.balance < 0 ? reportPdf.money(-r.balance) : '' },
    ],
    rows,
    footerRows: [{ code: '', name: 'Total', type: '', debit: reportPdf.money(totalDr), credit: reportPdf.money(totalCr) }],
  });
});

router.get('/reports/profit-loss', async (req, res) => {
  const filters = reportFilters(req);
  let rows = [];
  try {
    rows = await computeTrialBalance(filters.range);
  } catch (error) {
    logAccountingSetupWarning('/reports/profit-loss', error);
  }
  const revenue = rows.filter(r => r.type === 'revenue');
  const expenses = rows.filter(r => r.type === 'expense');

  // Revenue is naturally a credit balance; flip sign for display as positive income.
  const revenueRows = revenue.map(r => ({ ...r, amount: -r.balance }));
  const expenseRows = expenses.map(r => ({ ...r, amount: r.balance }));

  const totalRevenue = revenueRows.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + r.amount, 0);
  const netIncome = totalRevenue - totalExpenses;

  res.render('accounting/reports/profit-loss', {
    title: 'Profit & loss', activeNav: 'accounting',
    revenueRows, expenseRows, totalRevenue, totalExpenses, netIncome, fmt, range: filters.range, rangeOptions: REPORT_DATE_OPTIONS,
  });
});

router.get('/reports/profit-loss.pdf', async (req, res) => {
  const filters = reportFilters(req);
  const [rows, company] = await Promise.all([computeTrialBalance(filters.range), getCompany()]);
  const revenueRows = rows.filter(r => r.type === 'revenue').map(r => ({ ...r, amount: -r.balance }));
  const expenseRows = rows.filter(r => r.type === 'expense').map(r => ({ ...r, amount: r.balance }));
  const totalRevenue = revenueRows.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + r.amount, 0);
  const netIncome = totalRevenue - totalExpenses;
  sendPdf(res, 'profit-loss.pdf', {
    title: 'Profit & loss',
    company,
    summary: [
      { label: 'Revenue', value: reportPdf.money(totalRevenue) },
      { label: 'Expenses', value: reportPdf.money(totalExpenses) },
      { label: 'Range', value: filters.range.label },
      { label: 'Net income', value: reportPdf.money(netIncome), color: netIncome >= 0 ? '#166534' : '#c0202b' },
    ],
    sections: [
      { title: 'Revenue', rows: revenueRows.map(r => ({ label: r.name, value: reportPdf.money(r.amount) })).concat([{ label: 'Total Revenue', value: reportPdf.money(totalRevenue), bold: true }]) },
      { title: 'Expenses', rows: expenseRows.map(r => ({ label: r.name, value: reportPdf.money(r.amount) })).concat([{ label: 'Total Expenses', value: reportPdf.money(totalExpenses), bold: true }]) },
      { title: 'Result', rows: [{ label: 'Net Income', value: reportPdf.money(netIncome), bold: true }] },
    ],
  });
});

router.get('/reports/balance-sheet', async (req, res) => {
  const filters = reportFilters(req);
  let rows = [];
  try {
    rows = await computeTrialBalance(filters.range);
  } catch (error) {
    logAccountingSetupWarning('/reports/balance-sheet', error);
  }
  const assets = rows.filter(r => r.type === 'asset').map(r => ({ ...r, amount: r.balance }));
  const liabilities = rows.filter(r => r.type === 'liability').map(r => ({ ...r, amount: -r.balance }));
  const equity = rows.filter(r => r.type === 'equity').map(r => ({ ...r, amount: -r.balance }));

  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0);

  const revenue = rows.filter(r => r.type === 'revenue').reduce((s, r) => s + (-r.balance), 0);
  const expenses = rows.filter(r => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
  const netIncome = revenue - expenses;
  const totalEquityWithIncome = totalEquity + netIncome;

  res.render('accounting/reports/balance-sheet', {
    title: 'Balance sheet', activeNav: 'accounting',
    assets, liabilities, equity, netIncome,
    totalAssets, totalLiabilities, totalEquity: totalEquityWithIncome,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquityWithIncome)) < 0.01,
    fmt, range: filters.range, rangeOptions: REPORT_DATE_OPTIONS,
  });
});

router.get('/reports/balance-sheet.pdf', async (req, res) => {
  const filters = reportFilters(req);
  const [rows, company] = await Promise.all([computeTrialBalance(filters.range), getCompany()]);
  const assets = rows.filter(r => r.type === 'asset').map(r => ({ ...r, amount: r.balance }));
  const liabilities = rows.filter(r => r.type === 'liability').map(r => ({ ...r, amount: -r.balance }));
  const equity = rows.filter(r => r.type === 'equity').map(r => ({ ...r, amount: -r.balance }));
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquityBase = equity.reduce((s, r) => s + r.amount, 0);
  const revenue = rows.filter(r => r.type === 'revenue').reduce((s, r) => s + (-r.balance), 0);
  const expenses = rows.filter(r => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
  const netIncome = revenue - expenses;
  const totalEquity = totalEquityBase + netIncome;
  const balanced = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01;
  sendPdf(res, 'balance-sheet.pdf', {
    title: 'Balance sheet',
    company,
    summary: [
      { label: 'Assets', value: reportPdf.money(totalAssets) },
      { label: 'Liabilities', value: reportPdf.money(totalLiabilities) },
      { label: 'Equity', value: reportPdf.money(totalEquity) },
      { label: 'Range', value: filters.range.label },
      { label: 'Status', value: balanced ? 'Balanced' : 'Unbalanced', color: balanced ? '#166534' : '#c0202b' },
    ],
    sections: [
      { title: 'Assets', rows: assets.map(a => ({ label: a.name, value: reportPdf.money(a.amount) })).concat([{ label: 'Total Assets', value: reportPdf.money(totalAssets), bold: true }]) },
      { title: 'Liabilities', rows: liabilities.map(l => ({ label: l.name, value: reportPdf.money(l.amount) })).concat([{ label: 'Total Liabilities', value: reportPdf.money(totalLiabilities), bold: true }]) },
      { title: 'Equity', rows: equity.map(e => ({ label: e.name, value: reportPdf.money(e.amount) })).concat([{ label: 'Net Income (current period)', value: reportPdf.money(netIncome) }, { label: 'Total Equity', value: reportPdf.money(totalEquity), bold: true }]) },
    ],
  });
});

// --- AR Aging ---

function ageBucket(dueDate) {
  if (!dueDate) return 'Current';
  const due = new Date(String(dueDate).slice(0,10));
  const today = new Date(); today.setHours(0,0,0,0);
  const age = Math.floor((today - due) / (1000*60*60*24));
  if (age <= 0) return 'Current';
  if (age <= 30) return '1-30';
  if (age <= 60) return '31-60';
  if (age <= 90) return '61-90';
  return '90+';
}

async function loadARAging(range) {
  const { data: invoices, error: invoicesErr } = await supabase
    .from('invoices')
    .select('*, work_orders!left(display_number, customers!left(id, name))')
    .not('status', 'in', '("paid","void","draft")')
    .order('due_date', { ascending: false });
  if (invoicesErr) throw invoicesErr;

  const rows = (invoices || []).map(inv => {
    const wo = inv.work_orders || {};
    const cust = wo.customers || {};
    const due = inv.due_date ? String(inv.due_date).slice(0,10) : null;
    const issued = inv.created_at ? String(inv.created_at).slice(0,10) : null;
    const ageDays = issued ? Math.max(0, Math.floor((new Date() - new Date(issued)) / (1000*60*60*24))) : 0;
    const balance = Number(inv.total || 0) - Number(inv.amount_paid || 0);
    return {
      id: inv.id,
      customer: cust.name || '—',
      invoiceNumber: wo.display_number ? `INV-${wo.display_number}` : `INV-${inv.id}`,
      issueDate: String(inv.created_at || '').slice(0,10),
      dueDate: due || '—',
      ageDays: Math.max(0, ageDays),
      balance,
      total: Number(inv.total || 0),
      bucket: ageBucket(inv.due_date),
      status: inv.status,
      reportDate: issued,
    };
  }).filter(r => inAgingRange(r.reportDate, range));

  // Sort by age desc
  rows.sort((a, b) => b.ageDays - a.ageDays);

  // Bucket totals
  const buckets = { Current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  rows.forEach(r => { buckets[r.bucket] = (buckets[r.bucket] || 0) + r.balance; });
  return { rows, buckets };
}

router.get('/ar-aging', async (req, res) => {
  const range = agingRange(req.query.range);
  const { rows, buckets } = await loadARAging(range);

  res.render('accounting/ar-aging', {
    title: 'AR Aging', activeNav: 'accounting',
    rows, buckets, fmt, range, rangeOptions: AGING_RANGE_OPTIONS,
  });
});

router.get('/ar-aging.pdf', async (req, res) => {
  const range = agingRange(req.query.range);
  const [{ rows, buckets }, company] = await Promise.all([loadARAging(range), getCompany()]);
  sendPdf(res, 'ar-aging.pdf', {
    title: 'Accounts receivable aging',
    company,
    summary: [{ label: 'Range', value: range.label }].concat(Object.keys(buckets).map(b => ({ label: b, value: reportPdf.money(buckets[b]), color: b === '90+' ? '#c0202b' : undefined }))),
    columns: [
      { key: 'customer', label: 'Customer', width: 2 },
      { key: 'invoiceNumber', label: 'Invoice', width: 1.2 },
      { key: 'dueDate', label: 'Due', width: 1 },
      { key: 'ageDays', label: 'Age', width: 0.8, align: 'right' },
      { key: 'total', label: 'Total', width: 1, align: 'right', value: r => reportPdf.money(r.total) },
      { key: 'balance', label: 'Balance', width: 1, align: 'right', value: r => reportPdf.money(r.balance), bold: r => Number(r.balance) > 0 },
      { key: 'bucket', label: 'Bucket', width: 0.9 },
    ],
    rows,
  });
});

// --- AP Aging ---

async function loadAPAging(range) {
  // Bills: unpaid or partially paid
  const { data: bills, error: billsErr } = await supabase
    .from('bills')
    .select('*, vendors!left(name)')
    .not('status', 'in', '("paid","void")')
    .order('due_date', { ascending: false });
  if (billsErr) throw billsErr;

  const billRows = (bills || []).map(b => {
    const due = b.due_date ? String(b.due_date).slice(0,10) : null;
    const billDate = b.bill_date ? String(b.bill_date).slice(0,10) : (b.created_at ? String(b.created_at).slice(0,10) : null);
    const ageDays = billDate ? Math.max(0, Math.floor((new Date() - new Date(billDate)) / (1000*60*60*24))) : 0;
    const balance = Number(b.total || 0) - Number(b.amount_paid || 0);
    return {
      id: b.id,
      vendor: b.vendors?.name || '—',
      source: 'Bill',
      ref: b.bill_number || `BL-${b.id}`,
      billDate,
      dueDate: due || '—',
      ageDays,
      balance: Math.max(0, balance),
      total: Number(b.total || 0),
      bucket: ageBucket(b.due_date),
      status: b.status,
      reportDate: billDate,
    };
  }).filter(r => r.balance > 0 && inAgingRange(r.reportDate, range));

  // Also check vendor_invoices (unpaid RPM imports)
  const { data: vinvs, error: viErr } = await supabase
    .from('vendor_invoices')
    .select('*, vendors!left(name)')
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (viErr) throw viErr;

  const viRows = (vinvs || []).map(v => {
    const due = null; // vendor_invoices have no due_date
    return {
      id: v.id,
      vendor: v.vendors?.name || '—',
      source: 'Vendor Invoice',
      ref: v.invoice_number || `VI-${v.id}`,
      billDate: String(v.created_at || '').slice(0,10),
      dueDate: '—',
      ageDays: 0,
      balance: Number(v.amount || 0),
      total: Number(v.amount || 0),
      bucket: 'Current',
      status: 'open',
      reportDate: String(v.created_at || '').slice(0,10),
    };
  }).filter(r => inAgingRange(r.reportDate, range));

  const rows = [...billRows, ...viRows].sort((a, b) => b.ageDays - a.ageDays);

  const buckets = { Current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  rows.forEach(r => { buckets[r.bucket] = (buckets[r.bucket] || 0) + r.balance; });
  return { rows, buckets };
}

router.get('/ap-aging', async (req, res) => {
  const range = agingRange(req.query.range);
  const { rows, buckets } = await loadAPAging(range);

  res.render('accounting/ap-aging', {
    title: 'AP Aging', activeNav: 'accounting',
    rows, buckets, fmt, range, rangeOptions: AGING_RANGE_OPTIONS,
  });
});

router.get('/ap-aging.pdf', async (req, res) => {
  const range = agingRange(req.query.range);
  const [{ rows, buckets }, company] = await Promise.all([loadAPAging(range), getCompany()]);
  sendPdf(res, 'ap-aging.pdf', {
    title: 'Accounts payable aging',
    company,
    summary: [{ label: 'Range', value: range.label }].concat(Object.keys(buckets).map(b => ({ label: b, value: reportPdf.money(buckets[b]), color: b === '90+' ? '#c0202b' : undefined }))),
    columns: [
      { key: 'vendor', label: 'Vendor', width: 2 },
      { key: 'source', label: 'Source', width: 1.1 },
      { key: 'ref', label: 'Reference', width: 1.2 },
      { key: 'dueDate', label: 'Due', width: 1 },
      { key: 'ageDays', label: 'Age', width: 0.8, align: 'right' },
      { key: 'total', label: 'Total', width: 1, align: 'right', value: r => reportPdf.money(r.total) },
      { key: 'balance', label: 'Balance', width: 1, align: 'right', value: r => reportPdf.money(r.balance), bold: r => Number(r.balance) > 0 },
      { key: 'bucket', label: 'Bucket', width: 0.9 },
    ],
    rows,
  });
});

function reportFilters(req) {
  return {
    range: reportDateRange(req.query.range),
    q: cleanQuery(req.query.q),
    status: cleanQuery(req.query.status || 'all') || 'all',
    vendor: cleanQuery(req.query.vendor || 'all') || 'all',
    customer: cleanQuery(req.query.customer || 'all') || 'all',
    employee: cleanQuery(req.query.employee || 'all') || 'all',
  };
}

async function loadInvoicePaymentRows(filters) {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      id, status, total, amount_paid, created_at, due_date, sent_at, paid_at, payment_terms, po_number,
      work_orders!left(display_number, unit_number,
        customers!left(id, name),
        jobs!left(title, customers!left(id, name)))
    `)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  return (data || []).map(inv => {
    const wo = inv.work_orders || {};
    const job = wo.jobs || {};
    const customer = wo.customers || job.customers || {};
    const issueDate = String(inv.created_at || '').slice(0, 10);
    const paidDate = inv.paid_at ? String(inv.paid_at).slice(0, 10) : '';
    const balance = numberValue(inv.total) - numberValue(inv.amount_paid);
    return {
      id: inv.id,
      customer_id: customer.id || null,
      customer: customer.name || 'Unassigned customer',
      invoice: wo.display_number ? `INV-${wo.display_number}` : `INV-${inv.id}`,
      work_order: wo.display_number ? `WO-${wo.display_number}` : '-',
      project: job.title || '-',
      po_number: inv.po_number || '-',
      status: inv.status || '-',
      issued: issueDate,
      due: inv.due_date || '-',
      paid_date: paidDate || '-',
      terms: inv.payment_terms || '-',
      total: numberValue(inv.total),
      received: numberValue(inv.amount_paid),
      balance,
      reportDate: paidDate || issueDate,
    };
  }).filter(row => inReportRange(row.reportDate, filters.range))
    .filter(row => filters.status === 'all' || row.status === filters.status)
    .filter(row => filters.customer === 'all' || String(row.customer_id) === String(filters.customer))
    .filter(row => includesQuery(row, filters.q));
}

async function loadBillPaymentRows(filters) {
  const { data, error } = await supabase
    .from('bills')
    .select('id, bill_number, status, bill_date, due_date, total, amount_paid, approved_at, updated_at, created_at, vendors!left(id, name)')
    .order('bill_date', { ascending: false })
    .limit(1000);
  if (error) throw error;

  return (data || []).map(bill => {
    const billDate = bill.bill_date || String(bill.created_at || '').slice(0, 10);
    const paymentDate = bill.status === 'paid' ? String(bill.updated_at || '').slice(0, 10) : '';
    const balance = numberValue(bill.total) - numberValue(bill.amount_paid);
    return {
      id: bill.id,
      vendor_id: bill.vendors?.id || null,
      vendor: bill.vendors?.name || 'Unassigned vendor',
      bill: bill.bill_number || `Bill #${bill.id}`,
      status: bill.status || '-',
      bill_date: billDate || '-',
      due: bill.due_date || '-',
      paid_date: paymentDate || '-',
      total: numberValue(bill.total),
      paid: numberValue(bill.amount_paid),
      balance,
      reportDate: paymentDate || billDate,
    };
  }).filter(row => inReportRange(row.reportDate, filters.range))
    .filter(row => filters.status === 'all' || row.status === filters.status)
    .filter(row => filters.vendor === 'all' || String(row.vendor_id) === String(filters.vendor))
    .filter(row => includesQuery(row, filters.q));
}

async function loadDepositRows(filters) {
  let bankRows = [];
  try {
    const { data, error } = await supabase
      .from('bank_transactions')
      .select('id, transaction_date, bank_detail, payee, account_name, received, memo, accounts:account_id(code, name)')
      .gt('received', 0)
      .order('transaction_date', { ascending: false })
      .limit(1000);
    if (error) throw error;
    bankRows = (data || []).map(tx => ({
      id: tx.id,
      source: 'Bank transaction',
      date: tx.transaction_date,
      account: tx.accounts ? `${tx.accounts.code} ${tx.accounts.name}` : (tx.account_name || 'Bank account'),
      name: tx.payee || '-',
      detail: tx.bank_detail || tx.memo || '-',
      amount: numberValue(tx.received),
      reportDate: tx.transaction_date,
    }));
  } catch (error) {
    bankRows = [];
  }

  const invoiceRows = (await loadInvoicePaymentRows({ ...filters, status: 'all', customer: 'all', q: '' }))
    .filter(row => numberValue(row.received) > 0)
    .map(row => ({
      id: row.id,
      source: 'Invoice payment',
      date: row.paid_date !== '-' ? row.paid_date : row.issued,
      account: 'Accounts Receivable',
      name: row.customer,
      detail: `${row.invoice} ${row.po_number !== '-' ? 'PO ' + row.po_number : ''}`.trim(),
      amount: row.received,
      reportDate: row.paid_date !== '-' ? row.paid_date : row.issued,
    }));

  return bankRows.concat(invoiceRows)
    .filter(row => inReportRange(row.reportDate, filters.range))
    .filter(row => includesQuery(row, filters.q))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function loadVendorBalanceRows(filters, detail = false) {
  const rows = await loadBillPaymentRows({ ...filters, status: 'all', q: '' });
  const open = rows.filter(row => row.status !== 'void' && numberValue(row.balance) > 0);
  if (detail) {
    return open
      .filter(row => filters.vendor === 'all' || String(row.vendor_id) === String(filters.vendor))
      .filter(row => includesQuery(row, filters.q));
  }

  const grouped = new Map();
  open.forEach(row => {
    const key = row.vendor_id || row.vendor;
    const current = grouped.get(key) || {
      vendor_id: row.vendor_id,
      vendor: row.vendor,
      open_bills: 0,
      total_billed: 0,
      paid: 0,
      balance: 0,
      oldest_due: row.due,
    };
    current.open_bills += 1;
    current.total_billed += row.total;
    current.paid += row.paid;
    current.balance += row.balance;
    if (row.due && row.due !== '-' && (!current.oldest_due || current.oldest_due === '-' || row.due < current.oldest_due)) current.oldest_due = row.due;
    grouped.set(key, current);
  });
  return Array.from(grouped.values())
    .filter(row => filters.vendor === 'all' || String(row.vendor_id) === String(filters.vendor))
    .filter(row => includesQuery(row, filters.q))
    .sort((a, b) => b.balance - a.balance);
}

async function loadPayrollLineRows(filters) {
  const { data, error } = await supabase
    .from('payroll_run_lines')
    .select(`
      id, earning_type, regular_hours, overtime_hours, gross_pay, employer_taxes, deductions, net_pay, labor_cost, allocation_status,
      payroll_runs!inner(id, pay_period_start, pay_period_end, pay_date, status),
      payroll_employees!left(id, display_name, role_title),
      jobs!left(title),
      work_orders!left(display_number)
    `)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  return (data || []).map(line => {
    const run = line.payroll_runs || {};
    return {
      id: line.id,
      employee_id: line.payroll_employees?.id || null,
      employee: line.payroll_employees?.display_name || 'Unassigned employee',
      role: line.payroll_employees?.role_title || '-',
      pay_date: run.pay_date || '-',
      period: [run.pay_period_start, run.pay_period_end].filter(Boolean).join(' to ') || '-',
      earning_type: line.earning_type || '-',
      project: line.jobs?.title || '-',
      work_order: line.work_orders?.display_number ? `WO-${line.work_orders.display_number}` : '-',
      regular_hours: numberValue(line.regular_hours),
      overtime_hours: numberValue(line.overtime_hours),
      gross_pay: numberValue(line.gross_pay),
      employer_taxes: numberValue(line.employer_taxes),
      deductions: numberValue(line.deductions),
      net_pay: numberValue(line.net_pay),
      labor_cost: numberValue(line.labor_cost),
      allocation_status: line.allocation_status || '-',
      reportDate: run.pay_date,
    };
  }).filter(row => inReportRange(row.reportDate, filters.range))
    .filter(row => filters.employee === 'all' || String(row.employee_id) === String(filters.employee))
    .filter(row => includesQuery(row, filters.q));
}

async function loadPayrollRunRows(filters) {
  const { data, error } = await supabase
    .from('payroll_runs')
    .select('id, source, pay_period_start, pay_period_end, pay_date, status, gross_pay, employer_taxes, deductions, net_pay')
    .order('pay_date', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(run => ({
    id: run.id,
    pay_date: run.pay_date || '-',
    period: [run.pay_period_start, run.pay_period_end].filter(Boolean).join(' to ') || '-',
    source: run.source || '-',
    status: run.status || '-',
    gross_pay: numberValue(run.gross_pay),
    employer_taxes: numberValue(run.employer_taxes),
    deductions: numberValue(run.deductions),
    net_pay: numberValue(run.net_pay),
    total_cost: numberValue(run.gross_pay) + numberValue(run.employer_taxes),
    reportDate: run.pay_date,
  })).filter(row => inReportRange(row.reportDate, filters.range))
    .filter(row => filters.status === 'all' || row.status === filters.status)
    .filter(row => includesQuery(row, filters.q));
}

async function loadReportOptions() {
  const [vendors, customers, employees] = await Promise.all([
    supabase.from('vendors').select('id, name').order('name', { ascending: true }).limit(500).then(r => r.data || []).catch(() => []),
    supabase.from('customers').select('id, name').order('name', { ascending: true }).limit(500).then(r => r.data || []).catch(() => []),
    supabase.from('payroll_employees').select('id, display_name').order('display_name', { ascending: true }).limit(500).then(r => r.data || []).catch(() => []),
  ]);
  return { vendors, customers, employees };
}

function summarizeRows(rows, fields) {
  return fields.map(field => ({
    label: field.label,
    value: field.money ? money(rows.reduce((sum, row) => sum + numberValue(row[field.key]), 0)) : String(rows.length),
  }));
}

function reportColumns(slug) {
  const currency = key => ({ key, label: key.replace(/_/g, ' '), type: 'money', align: 'right' });
  switch (slug) {
    case 'ar-aging-detail':
      return [
        { key: 'customer', label: 'Customer' }, { key: 'invoice', label: 'Invoice' }, { key: 'status', label: 'Status' },
        { key: 'issued', label: 'Issued' }, { key: 'due', label: 'Due' }, currency('total'), currency('received'), currency('balance'),
      ];
    case 'ap-aging-detail':
    case 'unpaid-bills':
    case 'vendor-balance-detail':
      return [
        { key: 'vendor', label: 'Vendor' }, { key: 'bill', label: 'Bill' }, { key: 'status', label: 'Status' },
        { key: 'bill_date', label: 'Bill date' }, { key: 'due', label: 'Due' }, currency('total'), currency('paid'), currency('balance'),
      ];
    case 'bills-applied-payments':
      return [
        { key: 'vendor', label: 'Vendor' }, { key: 'bill', label: 'Bill' }, { key: 'status', label: 'Status' },
        { key: 'bill_date', label: 'Bill date' }, { key: 'paid_date', label: 'Paid date' }, currency('total'), currency('paid'), currency('balance'),
      ];
    case 'bill-payment-list':
      return [
        { key: 'vendor', label: 'Vendor' }, { key: 'bill', label: 'Bill' }, { key: 'paid_date', label: 'Paid date' },
        currency('paid'), { key: 'status', label: 'Status' },
      ];
    case 'deposit-detail':
      return [
        { key: 'date', label: 'Date' }, { key: 'source', label: 'Source' }, { key: 'name', label: 'Name' },
        { key: 'detail', label: 'Detail' }, { key: 'account', label: 'Account' }, currency('amount'),
      ];
    case 'invoices-received-payments':
      return [
        { key: 'customer', label: 'Customer' }, { key: 'invoice', label: 'Invoice' }, { key: 'po_number', label: 'PO #' },
        { key: 'status', label: 'Status' }, { key: 'issued', label: 'Issued' }, { key: 'paid_date', label: 'Paid date' },
        currency('total'), currency('received'), currency('balance'),
      ];
    case 'vendor-balance-summary':
      return [
        { key: 'vendor', label: 'Vendor' }, { key: 'open_bills', label: 'Open bills', align: 'right' },
        { key: 'oldest_due', label: 'Oldest due' }, currency('total_billed'), currency('paid'), currency('balance'),
      ];
    case 'paycheck-history':
      return [
        { key: 'employee', label: 'Employee' }, { key: 'pay_date', label: 'Pay date' }, { key: 'period', label: 'Period' },
        { key: 'earning_type', label: 'Earning' }, currency('gross_pay'), currency('deductions'), currency('net_pay'),
      ];
    case 'payroll-details':
      return [
        { key: 'employee', label: 'Employee' }, { key: 'pay_date', label: 'Pay date' }, { key: 'project', label: 'Project' },
        { key: 'work_order', label: 'WO' }, { key: 'regular_hours', label: 'Reg hrs', align: 'right' }, { key: 'overtime_hours', label: 'OT hrs', align: 'right' },
        currency('gross_pay'), currency('employer_taxes'), currency('labor_cost'),
      ];
    case 'payroll-summary-by-employee':
    case 'total-payroll-cost':
    case 'payroll-tax-wage-summary':
      return [
        { key: 'employee', label: 'Employee' }, { key: 'role', label: 'Role' },
        { key: 'regular_hours', label: 'Reg hrs', align: 'right' }, { key: 'overtime_hours', label: 'OT hrs', align: 'right' },
        currency('gross_pay'), currency('employer_taxes'), currency('deductions'), currency('net_pay'), currency('labor_cost'),
      ];
    case 'payroll-summary':
    case 'payroll-tax-liability':
      return [
        { key: 'pay_date', label: 'Pay date' }, { key: 'period', label: 'Period' }, { key: 'status', label: 'Status' },
        currency('gross_pay'), currency('employer_taxes'), currency('deductions'), currency('net_pay'), currency('total_cost'),
      ];
    default:
      return [];
  }
}

async function loadGenericReport(slug, filters) {
  let rows = [];
  if (slug === 'ar-aging-detail') {
    rows = (await loadInvoicePaymentRows(filters)).filter(row => numberValue(row.balance) > 0 && row.status !== 'void' && row.status !== 'draft');
  } else if (slug === 'ap-aging-detail' || slug === 'unpaid-bills') {
    rows = (await loadBillPaymentRows(filters)).filter(row => numberValue(row.balance) > 0 && row.status !== 'void');
  } else if (slug === 'bills-applied-payments') {
    rows = await loadBillPaymentRows(filters);
  } else if (slug === 'bill-payment-list') {
    rows = (await loadBillPaymentRows({ ...filters, status: 'paid' })).filter(row => numberValue(row.paid) > 0);
  } else if (slug === 'deposit-detail') {
    rows = await loadDepositRows(filters);
  } else if (slug === 'invoices-received-payments') {
    rows = await loadInvoicePaymentRows(filters);
  } else if (slug === 'vendor-balance-summary') {
    rows = await loadVendorBalanceRows(filters, false);
  } else if (slug === 'vendor-balance-detail') {
    rows = await loadVendorBalanceRows(filters, true);
  } else if (slug === 'payroll-summary-by-employee' || slug === 'total-payroll-cost' || slug === 'payroll-tax-wage-summary') {
    const lineRows = await loadPayrollLineRows(filters);
    const grouped = new Map();
    lineRows.forEach(row => {
      const key = row.employee_id || row.employee;
      const current = grouped.get(key) || { employee_id: row.employee_id, employee: row.employee, role: row.role, regular_hours: 0, overtime_hours: 0, gross_pay: 0, employer_taxes: 0, deductions: 0, net_pay: 0, labor_cost: 0 };
      ['regular_hours', 'overtime_hours', 'gross_pay', 'employer_taxes', 'deductions', 'net_pay', 'labor_cost'].forEach(k => { current[k] += numberValue(row[k]); });
      grouped.set(key, current);
    });
    rows = Array.from(grouped.values()).filter(row => includesQuery(row, filters.q));
  } else if (slug === 'payroll-details' || slug === 'paycheck-history') {
    rows = await loadPayrollLineRows(filters);
  } else if (slug === 'payroll-summary' || slug === 'payroll-tax-liability') {
    rows = await loadPayrollRunRows(filters);
  }

  const columns = reportColumns(slug);
  const summary = [
    { label: 'Rows', value: String(rows.length) },
    { label: 'Range', value: filters.range.label },
  ];
  columns.filter(c => c.type === 'money').slice(-3).forEach(c => {
    summary.push({ label: c.label, value: money(rows.reduce((sum, row) => sum + numberValue(row[c.key]), 0)) });
  });

  return { rows, columns, summary };
}

function pdfColumnsFromReport(columns) {
  return columns.map(col => ({
    key: col.key,
    label: col.label,
    width: col.type === 'money' ? 1 : 1.4,
    align: col.align || (col.type === 'money' ? 'right' : 'left'),
    value: row => col.type === 'money' ? reportPdf.money(row[col.key]) : row[col.key],
  }));
}

router.get('/reports/:slug.pdf', async (req, res, next) => {
  const definition = getFavoriteReport(req.params.slug);
  if (!definition || ['balance-sheet', 'profit-loss'].includes(definition.slug)) return next();
  const filters = reportFilters(req);
  try {
    const [report, company] = await Promise.all([loadGenericReport(definition.slug, filters), getCompany()]);
    sendPdf(res, `${definition.slug}.pdf`, {
      title: definition.title,
      subtitle: `Range: ${filters.range.label}`,
      company,
      summary: report.summary,
      columns: pdfColumnsFromReport(report.columns),
      rows: report.rows,
    });
  } catch (error) {
    logAccountingSetupWarning(`/reports/${definition.slug}.pdf`, error);
    res.status(503).render('error', {
      title: 'Report unavailable',
      code: 503,
      message: 'This report is waiting on matching accounting/payroll data before it can be exported.',
    });
  }
});

router.get('/reports/:slug', async (req, res, next) => {
  const definition = getFavoriteReport(req.params.slug);
  if (!definition || ['balance-sheet', 'profit-loss'].includes(definition.slug)) return next();
  const filters = reportFilters(req);
  const options = await loadReportOptions();
  let report = { rows: [], columns: [], summary: [] };
  let warning = null;
  try {
    report = await loadGenericReport(definition.slug, filters);
  } catch (error) {
    logAccountingSetupWarning(`/reports/${definition.slug}`, error);
    warning = 'This report is waiting on the matching accounting/payroll table or import data.';
  }
  res.render('accounting/reports/generic', {
    title: definition.title,
    activeNav: 'accounting',
    definition,
    filters,
    options,
    dateOptions: REPORT_DATE_OPTIONS,
    rows: report.rows,
    columns: report.columns,
    summary: report.summary,
    warning,
    money,
  });
});

module.exports = router;
