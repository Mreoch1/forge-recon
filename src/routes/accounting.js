/**
 * Accounting module routes (v0.6).
 *
 * All gated by requireManager in server.js.
 *
 *   GET  /accounting                       — hub page with KPIs
 *   GET  /accounting/accounts              — chart of accounts list
 *   GET  /accounting/journal               — journal entries list (with lines)
 *   GET  /accounting/journal/:id           — single JE detail
 *   GET  /accounting/reports/trial-balance — real trial balance from journal_lines
 *   GET  /accounting/reports/profit-loss   — real P&L from revenue + expense accounts
 *   GET  /accounting/reports/balance-sheet — real balance sheet from asset/liability/equity
 */

const express = require('express');
const db = require('../db/db');

const router = express.Router();

function fmt(n) { const num = Number(n); return isFinite(num) ? num.toFixed(2) : '0.00'; }

// --- hub ---

router.get('/', (req, res) => {
  // Top-level KPIs from the GL
  const accountsCount = (db.get('SELECT COUNT(*) AS n FROM accounts') || {}).n || 0;
  const jeCount = (db.get('SELECT COUNT(*) AS n FROM journal_entries') || {}).n || 0;
  const billCount = (db.get('SELECT COUNT(*) AS n FROM bills') || {}).n || 0;
  const vendorCount = (db.get('SELECT COUNT(*) AS n FROM vendors WHERE archived = 0') || {}).n || 0;

  const recentEntries = db.all(
    `SELECT je.id, je.entry_date, je.description, je.source_type, je.created_at,
            (SELECT COALESCE(SUM(debit), 0) FROM journal_lines WHERE journal_entry_id = je.id) AS total
     FROM journal_entries je
     ORDER BY je.entry_date DESC, je.created_at DESC
     LIMIT 10`
  );

  res.render('accounting/index', {
    title: 'Accounting', activeNav: 'accounting',
    accountsCount, jeCount, billCount, vendorCount, recentEntries
  });
});

// --- chart of accounts ---

router.get('/accounts', (req, res) => {
  const accounts = db.all('SELECT * FROM accounts ORDER BY code ASC');

  // Group by type for display
  const grouped = { asset: [], liability: [], equity: [], revenue: [], expense: [] };
  accounts.forEach(a => { (grouped[a.type] = grouped[a.type] || []).push(a); });

  res.render('accounting/accounts', {
    title: 'Chart of accounts', activeNav: 'accounting',
    accounts, grouped
  });
});

// --- journal ---

router.get('/journal', (req, res) => {
  const entries = db.all(
    `SELECT je.*, u.name AS created_by_name,
            (SELECT COALESCE(SUM(debit), 0) FROM journal_lines WHERE journal_entry_id = je.id) AS total_debits
     FROM journal_entries je
     LEFT JOIN users u ON u.id = je.created_by_user_id
     ORDER BY je.entry_date DESC, je.created_at DESC
     LIMIT 100`
  );
  res.render('accounting/journal', {
    title: 'Journal entries', activeNav: 'accounting',
    entries
  });
});

router.get('/journal/:id', (req, res) => {
  const entry = db.get(
    `SELECT je.*, u.name AS created_by_name
     FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by_user_id
     WHERE je.id = ?`,
    [req.params.id]
  );
  if (!entry) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Journal entry not found.' });
  }
  const lines = db.all(
    `SELECT jl.*, a.code AS account_code, a.name AS account_name, a.type AS account_type
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ?
     ORDER BY jl.id ASC`,
    [req.params.id]
  );
  res.render('accounting/journal-detail', {
    title: `Journal #${entry.id}`, activeNav: 'accounting',
    entry, lines
  });
});

// --- reports ---

function computeTrialBalance() {
  // For each active account: sum of debits and credits from journal_lines.
  return db.all(`
    SELECT a.id, a.code, a.name, a.type,
           COALESCE(SUM(jl.debit), 0) AS total_debits,
           COALESCE(SUM(jl.credit), 0) AS total_credits,
           COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    WHERE a.active = 1
    GROUP BY a.id
    ORDER BY a.code ASC
  `);
}

router.get('/reports/trial-balance', (req, res) => {
  const rows = computeTrialBalance();
  // Sum debit/credit balances
  let totalDr = 0, totalCr = 0;
  rows.forEach(r => {
    if (r.balance > 0) totalDr += r.balance;
    else if (r.balance < 0) totalCr += -r.balance;
  });
  res.render('accounting/reports/trial-balance', {
    title: 'Trial balance', activeNav: 'accounting',
    rows, totalDr, totalCr
  });
});

router.get('/reports/profit-loss', (req, res) => {
  const rows = computeTrialBalance();
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
    revenueRows, expenseRows, totalRevenue, totalExpenses, netIncome
  });
});

router.get('/reports/balance-sheet', (req, res) => {
  const rows = computeTrialBalance();
  const assets = rows.filter(r => r.type === 'asset').map(r => ({ ...r, amount: r.balance }));
  // Liabilities + equity are naturally credit balances; flip for positive display.
  const liabilities = rows.filter(r => r.type === 'liability').map(r => ({ ...r, amount: -r.balance }));
  const equity = rows.filter(r => r.type === 'equity').map(r => ({ ...r, amount: -r.balance }));

  // Net income from current period flows into equity for the bal-sheet check
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0);

  // Compute current-period net income (revenue - expenses) and add to equity total
  const revenue = rows.filter(r => r.type === 'revenue').reduce((s, r) => s + (-r.balance), 0);
  const expenses = rows.filter(r => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
  const netIncome = revenue - expenses;
  const totalEquityWithIncome = totalEquity + netIncome;

  res.render('accounting/reports/balance-sheet', {
    title: 'Balance sheet', activeNav: 'accounting',
    assets, liabilities, equity, netIncome,
    totalAssets, totalLiabilities, totalEquity: totalEquityWithIncome,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquityWithIncome)) < 0.01
  });
});

module.exports = router;
