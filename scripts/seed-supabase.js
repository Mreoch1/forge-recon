/**
 * seed-supabase.js — Seed mock data into Supabase for production demo.
 * Run: USE_PG=1 node scripts/seed-supabase.js
 * WARNING: DESTRUCTIVE — deletes and recreates all mock data.
 */
require('dotenv').config();
const path = require('path');
const bcrypt = require('bcryptjs');

process.env.USE_PG = '1';
const db = require('../src/db/db');

async function seed() {
  await db.init();
  console.log('Seeding Supabase mock data...');

  // Clear existing data — TRUNCATE in dependency order
  const tables = ['company_settings','users','items_library','accounts','customers','vendors',
    'jobs','work_orders','work_order_line_items','wo_notes','wo_photos',
    'estimates','estimate_line_items','invoices','invoice_line_items',
    'bills','bill_lines','journal_entries','journal_lines',
    'folders','files','audit_logs','closures','pending_confirmations','ai_extractions'];
  for (const t of tables) {
    try { await db.exec(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`); } catch(e) { console.warn('truncate failed:', t, e.message); }
  }
  console.log('  Cleared all tables.');

  // Admin user
  const ah = await bcrypt.hash('admin123!', 10);
  await db.run("INSERT INTO users (email, password_hash, name, role, active, created_at, updated_at) VALUES ('admin@recon.local', ?, 'Admin', 'admin', 1, now(), now())", [ah]);
  // Workers
  const wh = await bcrypt.hash('worker123', 10);
  const workers = [
    ['mike.kowalski@recon.local', wh, 'Mike Kowalski', 'manager'],
    ['carlos.mendez@recon.local', wh, 'Carlos Mendez', 'worker'],
    ['dave.thompson@recon.local', wh, 'Dave Thompson', 'worker'],
  ];
  for (const [em, pw, nm, rl] of workers) {
    await db.run("INSERT INTO users (email, password_hash, name, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, now(), now())", [em, pw, nm, rl]);
  }

  // Company settings
  await db.run("INSERT INTO company_settings (id, company_name, default_tax_rate, default_payment_terms, next_wo_main_number, current_year) VALUES (1, 'Recon Construction', 6.25, 'Net 30', 1, 2026)");

  // Customers
  const customers = ['Cambridge Towers Property Mgmt','MacKenzie Homes LLC','Beacon Hill Restoration','Northeast General Contractors',"The O'Brien Family",'Allston Veterinary Clinic'];
  for (const n of customers) {
    await db.run("INSERT INTO customers (name, email, phone, city, state, mock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, now(), now())",
      [n, n.toLowerCase().replace(/[^a-z]/g,'')+'@example.com', '(617) 555-0101', 'Boston', 'MA']);
  }
  // Job
  await db.run("INSERT INTO jobs (customer_id, title, address, city, state, status, mock, created_at, updated_at) VALUES (1, 'Kitchen Renovation', '123 Main St', 'Boston', 'MA', 'in_progress', 1, now(), now())");
  // WO
  const base = await db.get("SELECT next_wo_main_number FROM company_settings WHERE id = 1");
  const mainNum = base ? base.next_wo_main_number : 1;
  await db.run("UPDATE company_settings SET next_wo_main_number = next_wo_main_number + 1 WHERE id = 1");
  const dn = String(mainNum).padStart(4, '0') + '-0000';
  await db.run("INSERT INTO work_orders (job_id, wo_number_main, wo_number_sub, display_number, status, scheduled_date, mock, created_at, updated_at) VALUES (1, ?, 0, ?, 'scheduled', current_date, 1, now(), now())", [mainNum, dn]);

  // Estimate
  await db.run("INSERT INTO estimates (work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, mock, created_at, updated_at) VALUES (1, 'draft', 10000, 6.25, 625, 10625, 5000, 1, now(), now())");
  await db.run("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, line_total, selected, sort_order) VALUES (1, 'Cabinet installation', 10, 500, 5000, 1, 1)");
  await db.run("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, line_total, selected, sort_order) VALUES (1, 'Countertop', 1, 3000, 3000, 1, 2)");
  await db.run("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, line_total, selected, sort_order) VALUES (1, 'Backsplash tile', 40, 50, 2000, 1, 3)");

  // Invoice
  await db.run("INSERT INTO invoices (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, amount_paid, due_date, mock, created_at, updated_at) VALUES (1, 1, 'sent', 10000, 6.25, 625, 10625, 0, current_date + interval '30 days', 1, now(), now())");

  // Vendors + Bill
  await db.run("INSERT INTO vendors (name, email, phone, mock, created_at, updated_at) VALUES ('Brockton Lumber Co.', 'orders@brocktonlumber.com', '508-555-0201', 1, now(), now())");
  await db.run("INSERT INTO bills (vendor_id, bill_number, status, total, due_date, mock, created_at, updated_at) VALUES (1, 'BL-2026-001', 'draft', 2500, current_date + interval '30 days', 1, now(), now())");

  // Items library
  await db.run("INSERT INTO items_library (description, quantity, unit, unit_price, cost, category, mock, created_at) VALUES ('Interior paint (gallon)', 1, 'ea', 45, 28, 'materials', 1, now())");

  // Accounts for accounting
  const accounts = [
    [1000, 'Cash', 'asset'],[1100, 'Accounts Receivable', 'asset'],[2000, 'Accounts Payable', 'liability'],
    [3000, 'Retained Earnings', 'equity'],[4000, 'Revenue', 'revenue'],[5000, 'Cost of Goods Sold', 'expense'],
    [5100, 'Salaries', 'expense'],[5200, 'Rent', 'expense'],[5300, 'Materials', 'expense'],
  ];
  for (const [code, name, type] of accounts) {
    await db.run("INSERT INTO accounts (code, name, type, created_at, updated_at) VALUES (?, ?, ?, now(), now())", [code, name, type]);
  }

  // Closures
  await db.run("INSERT INTO closures (date_start, date_end, name, type, created_by_user_id, created_at) VALUES (current_date + interval '90 days', current_date + interval '92 days', 'Company Retreat', 'company_event', 1, now())");
  await db.run("INSERT INTO closures (date_start, name, type, created_by_user_id, created_at) VALUES (current_date + interval '14 days', 'Independence Day', 'holiday', 1, now())");

  // Folder for entity files (schema may have skipped this)
  try { await db.run("INSERT INTO folders (name, entity_type, entity_id, created_by_user_id, created_at, updated_at) VALUES ('Root', 'customer', 1, 1, now(), now())"); } catch(e) { console.warn('folders table not available'); }

  console.log('Seed complete. Users: admin@recon.local / admin123!, worker accounts with worker123');
  const counts = {};
  for (const t of ['users','customers','jobs','work_orders','estimates','invoices','vendors','bills','accounts','closures','items_library']) {
    try { const r = await db.get(`SELECT COUNT(*) AS n FROM ${t}`); counts[t] = r ? r.n : 0; } catch(e) { counts[t] = 'n/a'; }
  }
  console.log('Row counts:', JSON.stringify(counts, null, 2));
}

seed().catch(e => { console.error('Seed failed:', e); process.exit(1); }).then(() => process.exit(0));
