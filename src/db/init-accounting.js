#!/usr/bin/env node
/**
 * Initialize the accounting schema and seed the starter chart of accounts.
 * Idempotent — safe to run multiple times.
 *
 * Usage: node src/db/init-accounting.js
 */

const path = require('path');
const fs = require('fs');
const db = require('./db');

const SCHEMA_PATH = path.join(__dirname, 'schema-accounting.sql');

// Starter chart of accounts (standard small construction firm)
const SEED_ACCOUNTS = [
  // Assets (1000-1999)
  { code: '1000', name: 'Cash',                       type: 'asset' },
  { code: '1100', name: 'Accounts Receivable',        type: 'asset' },
  { code: '1200', name: 'Materials Inventory',        type: 'asset' },
  { code: '1300', name: 'Equipment',                  type: 'asset' },
  { code: '1400', name: 'Prepaid Expenses',           type: 'asset' },
  // Liabilities (2000-2999)
  { code: '2000', name: 'Accounts Payable',           type: 'liability' },
  { code: '2100', name: 'Sales Tax Payable',          type: 'liability' },
  { code: '2200', name: 'Accrued Liabilities',        type: 'liability' },
  { code: '2300', name: 'Loans Payable',              type: 'liability' },
  // Equity (3000-3999)
  { code: '3000', name: 'Owners Equity',              type: 'equity' },
  { code: '3100', name: 'Retained Earnings',          type: 'equity' },
  // Revenue (4000-4999)
  { code: '4000', name: 'Service Revenue',            type: 'revenue' },
  { code: '4100', name: 'Material Sales',             type: 'revenue' },
  { code: '4200', name: 'Other Income',               type: 'revenue' },
  // Expenses (5000-5999)
  { code: '5000', name: 'Cost of Goods Sold',         type: 'expense' },
  { code: '5100', name: 'Labor',                      type: 'expense' },
  { code: '5200', name: 'Subcontractors',             type: 'expense' },
  { code: '5300', name: 'Materials',                  type: 'expense' },
  { code: '5400', name: 'Equipment Rental',           type: 'expense' },
  { code: '5500', name: 'Vehicle & Fuel',             type: 'expense' },
  { code: '5600', name: 'Insurance',                  type: 'expense' },
  { code: '5700', name: 'Office & Admin',             type: 'expense' },
  { code: '5800', name: 'Permits & Fees',             type: 'expense' },
  { code: '5900', name: 'Miscellaneous',              type: 'expense' },
];

async function main() {
  await db.init();

  // Apply schema
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
  console.log('Accounting schema applied.');

  // Seed chart of accounts (idempotent — skip if any accounts exist)
  const existing = db.get('SELECT COUNT(*) AS n FROM accounts');
  if (existing && existing.n > 0) {
    console.log(`Accounts already seeded (${existing.n} found) — skipping.`);
  } else {
    for (const acc of SEED_ACCOUNTS) {
      db.run(
        'INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)',
        [acc.code, acc.name, acc.type]
      );
    }
    console.log(`Seeded ${SEED_ACCOUNTS.length} starter accounts.`);
  }

  await db.persist();
  console.log('Accounting init complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('Accounting init failed:', err);
  process.exit(1);
});
