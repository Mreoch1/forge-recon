/**
 * QuickBooks-lite accounting module — skeleton routes.
 *
 * Routes: (all gated by requireManager in server.js)
 *   GET  /accounting                    — dashboard / hub page
 *   GET  /accounting/accounts           — chart of accounts list
 *   GET  /accounting/journal            — journal entries list
 *   GET  /accounting/reports/trial-balance — stub
 *   GET  /accounting/reports/profit-loss    — stub
 *   GET  /accounting/reports/balance-sheet  — stub
 *
 * Full CRUD + automatic JE creation from invoice events will be added
 * in the next session. These stubs ensure the nav links render and the
 * skeleton is navigable.
 */

const express = require('express');
const db = require('../db/db');

const router = express.Router();

// Dashboard
router.get('/', (req, res) => {
  res.render('accounting/index', {
    title: 'Accounting',
    activeNav: 'accounting',
  });
});

// Chart of accounts
router.get('/accounts', (req, res) => {
  const accounts = db.all(
    'SELECT * FROM accounts ORDER BY code ASC'
  );
  res.render('accounting/accounts', {
    title: 'Chart of accounts',
    activeNav: 'accounting',
    accounts,
  });
});

// Journal entries
router.get('/journal', (req, res) => {
  const entries = db.all(
    `SELECT je.*, u.name AS created_by_name
     FROM journal_entries je
     LEFT JOIN users u ON u.id = je.created_by_user_id
     ORDER BY je.entry_date DESC, je.created_at DESC
     LIMIT 50`
  );
  res.render('accounting/journal', {
    title: 'Journal entries',
    activeNav: 'accounting',
    entries,
  });
});

// Report stubs
router.get('/reports/trial-balance', (req, res) => {
  res.render('accounting/reports/trial-balance', {
    title: 'Trial balance',
    activeNav: 'accounting',
  });
});

router.get('/reports/profit-loss', (req, res) => {
  res.render('accounting/reports/profit-loss', {
    title: 'Profit & loss',
    activeNav: 'accounting',
  });
});

router.get('/reports/balance-sheet', (req, res) => {
  res.render('accounting/reports/balance-sheet', {
    title: 'Balance sheet',
    activeNav: 'accounting',
  });
});

module.exports = router;
