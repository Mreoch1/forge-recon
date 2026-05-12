/**
 * Accounting module routes (v0.6) - Supabase SDK.
 *
 * All gated by requireManager in server.js.
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
const supabase = require('../db/supabase');

const router = express.Router();

function fmt(n) { const num = Number(n); return isFinite(num) ? num.toFixed(2) : '0.00'; }

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
  const [{ count: accountsCount }, { count: jeCount }, { count: billCount }, { count: vendorCount },
         { data: entries, error: entriesErr }] = await Promise.all([
    supabase.from('accounts').select('*', { count: 'exact', head: true }),
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }),
    supabase.from('bills').select('*', { count: 'exact', head: true }),
    supabase.from('vendors').select('*', { count: 'exact', head: true }).eq('archived', false),
    supabase.from('journal_entries')
      .select('id, entry_date, description, source_type, created_at')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  if (entriesErr) throw entriesErr;

  const recentEntries = [];
  for (const e of (entries || [])) {
    const total = await totalDebitsForEntry(e.id);
    recentEntries.push({ ...e, total });
  }

  res.render('accounting/index', {
    title: 'Accounting', activeNav: 'accounting',
    accountsCount: accountsCount || 0,
    jeCount: jeCount || 0,
    billCount: billCount || 0,
    vendorCount: vendorCount || 0,
    recentEntries,
  });
});

// --- chart of accounts ---

router.get('/accounts', async (req, res) => {
  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('*')
    .order('code', { ascending: true });
  if (error) throw error;

  const grouped = { asset: [], liability: [], equity: [], revenue: [], expense: [] };
  (accounts || []).forEach(a => { (grouped[a.type] = grouped[a.type] || []).push(a); });

  res.render('accounting/accounts', {
    title: 'Chart of accounts', activeNav: 'accounting',
    accounts: accounts || [], grouped,
  });
});

// --- journal ---

router.get('/journal', async (req, res) => {
  const { data: rawEntries, error } = await supabase
    .from('journal_entries')
    .select('*, users:created_by_user_id ( name )')
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100);
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

  res.render('accounting/journal', {
    title: 'Journal entries', activeNav: 'accounting',
    entries,
  });
});

router.get('/journal/:id', async (req, res) => {
  const { data: raw, error: entryErr } = await supabase
    .from('journal_entries')
    .select('*, users:created_by_user_id ( name )')
    .eq('id', req.params.id)
    .maybeSingle();
  if (entryErr) throw entryErr;
  if (!raw) {
    return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Journal entry not found.' });
  }
  const { users, ...rest } = raw;
  const entry = { ...rest, created_by_name: users?.name || null };

  const { data: rawLines, error: linesErr } = await supabase
    .from('journal_lines')
    .select('*, accounts!inner ( code, name, type )')
    .eq('journal_entry_id', req.params.id)
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

  res.render('accounting/journal-detail', {
    title: `Journal #${entry.id}`, activeNav: 'accounting',
    entry, lines,
  });
});

// --- reports ---

async function computeTrialBalance() {
  const [{ data: accounts, error: aErr }, { data: lines, error: lErr }] = await Promise.all([
    supabase.from('accounts').select('id, code, name, type').eq('active', true).order('code', { ascending: true }),
    supabase.from('journal_lines').select('account_id, debit, credit'),
  ]);
  if (aErr) throw aErr;
  if (lErr) throw lErr;

  const totals = {};
  (lines || []).forEach(l => {
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
  const rows = await computeTrialBalance();
  let totalDr = 0, totalCr = 0;
  rows.forEach(r => {
    if (r.balance > 0) totalDr += r.balance;
    else if (r.balance < 0) totalCr += -r.balance;
  });
  res.render('accounting/reports/trial-balance', {
    title: 'Trial balance', activeNav: 'accounting',
    rows, totalDr, totalCr, fmt,
  });
});

router.get('/reports/profit-loss', async (req, res) => {
  const rows = await computeTrialBalance();
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
    revenueRows, expenseRows, totalRevenue, totalExpenses, netIncome, fmt,
  });
});

router.get('/reports/balance-sheet', async (req, res) => {
  const rows = await computeTrialBalance();
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
    fmt,
  });
});

module.exports = router;
