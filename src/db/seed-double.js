/**
 * seed-double.js — Append 2x more mock data on top of an existing seed.
 * Run AFTER `npm run seed:mock` to double all entity counts.
 *
 * Usage: node src/db/seed-double.js [--reset]
 *
 * Doubles: customers, vendors, jobs, work_orders, estimates,
 * invoices, bills, items_library, wo_notes.
 */
require('dotenv').config();
const path = require('path');
const db = require('./db');
const posting = require('../services/accounting-posting');
const { writeAudit } = require('../services/audit');

const RESET_FLAG = process.argv.includes('--reset');
const SENTINEL = 'mock_data_doubled';
const TAX_RATE = 6.25;
const TODAY = '2026-05-10';

// ── Helpers ──
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function rprice(min, max) { return Math.round((Math.random() * (max - min) + min) * 100) / 100; }

// ── Migrate: ensure mock column exists ──
function ensureMockCol(table) {
  const cols = db.all(`PRAGMA table_info(${table})`).map(c => c.name);
  if (!cols.includes('mock')) {
    db.run(`ALTER TABLE ${table} ADD COLUMN mock INTEGER NOT NULL DEFAULT 0`);
  }
}

// ── Reset ──
function resetDoubleData() {
  console.log('  Resetting doubled mock data...');
  // Delete records where mock=1 AND the sentinel for original batch
  // Since we use a separate sentinel, we can delete all mock=1 records
  // that were created AFTER the original seed.
  // Strategy: delete everything with mock=1 that isn't the original sentinel
  const tables = ['customers','vendors','jobs','work_orders','estimates','invoices','bills',
    'estimate_line_items','work_order_line_items','invoice_line_items','bill_lines',
    'wo_notes','items_library','audit_logs','wo_photos'];
  tables.forEach(t => {
    try { db.run(`DELETE FROM ${t} WHERE mock = 1`); } catch(e) {}
  });
  // Also clean orphan journal entries from doubled invoices/bills
  try {
    db.run(`DELETE FROM journal_lines WHERE journal_entry_id IN (
      SELECT id FROM journal_entries WHERE id NOT IN (
        SELECT je.id FROM journal_entries je
        LEFT JOIN invoices i ON (je.source_type='invoice' AND je.source_id=i.id)
        LEFT JOIN bills b ON (je.source_type='bill' AND je.source_id=b.id)
        WHERE i.id IS NULL AND b.id IS NULL AND je.source_type IN ('invoice','bill')
      ) AND source_type IN ('invoice','bill')
    )`);
    db.run(`DELETE FROM journal_entries WHERE id NOT IN (
      SELECT DISTINCT journal_entry_id FROM journal_lines
    )`);
  } catch(e) { console.error('  JE cleanup:', e.message); }
  console.log('  Done.');
}

// ── Double each domain ──
function doubleData() {
  console.log('\n  == 2x Mock Data ==');

  // Items library: 25 → 50
  ensureMockCol('items_library');
  // ── Customers (12 → 24) ──
  ensureMockCol('customers');
  const existingCustomerCount = (db.get('SELECT COUNT(*) as n FROM customers WHERE mock=1') || {}).n || 0;
  if (existingCustomerCount >= 24) {
    console.log('  Customers: already doubled');
  } else {
    const cities = ['Boston','Cambridge','Somerville','Medford','Quincy','Newton','Brookline','Waltham','Arlington','Everett','Malden','Revere'];
    const customerNames = [
      'Bay State Developers', 'Commonwealth Contractors', 'Harbor View Builders',
      'North End Renovations', 'South Boston Construction', 'East Boston Home Pros',
      'Jamaica Plain Builders', 'Roxbury Development', 'Dorchester Renovations',
      'Charlestown Contracting', 'Hyde Park Builders', 'Allston-Brighton Construction'
    ];
    customerNames.slice(0, 12).forEach((name, i) => {
      const city = cities[i % cities.length];
      db.run(`INSERT INTO customers (name, email, phone, address, city, state, zip, notes, created_at, updated_at, mock)
        VALUES (?, ?, ?, ?, ?, 'MA', ?, ?, ?, ?, 1)`,
        [name, `${name.toLowerCase().replace(/\s+/g,'.')}@example.com`,
         `(617) ${String(randInt(200,999)).padStart(3,'0')}-${String(randInt(1000,9999))}`,
         `${randInt(1,999)} ${pick(['Main','Oak','Elm','Park','River','High','Pine','Maple'])} St`,
         city, String(randInt(2100,2499)).padStart(5,'0'),
         `Multi-family renovation specialist — ${city} area.`,
         `2026-0${randInt(3,4)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`,
         `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`]
      );
    });
    console.log('  Customers: 24');
  }

  // ── Vendors (8 → 16) ──
  if ((db.get('SELECT COUNT(*) as n FROM vendors WHERE mock=1') || {}).n >= 16) {
    console.log('  Vendors: already doubled');
  } else {
    const vendorNames = [
      'Beacon Hill Supply Co.', 'South End Materials', 'Charlestown Lumber',
      'Fenway Tools & Equipment', 'Back Bay Plumbing', 'Seaport Electrical',
      'North Station HVAC Supply', 'East Boston Roofing Supply'
    ];
    const expenseAccounts = db.all('SELECT id FROM accounts WHERE type IN (\'expense\',\'cogs\') AND active=1');
    vendorNames.forEach((name, i) => {
      db.run(`INSERT INTO vendors (name, email, phone, address, city, state, zip, default_expense_account_id, notes, created_at, mock)
        VALUES (?, ?, ?, ?, ?, 'MA', ?, ?, ?, datetime('now'), 1)`,
        [name, `orders@${name.toLowerCase().replace(/[^a-z0-9]/g,'')}.com`,
         `(617) ${String(randInt(300,699)).padStart(3,'0')}-${String(randInt(1000,9999))}`,
         `${randInt(1,500)} ${pick(['Industrial','Commerce','Trade','Supply','Factory','Warehouse','Distribution','Logistics'])} Dr`,
         pick(['Boston','Charlestown','Somerville','Everett']),
         String(randInt(2100,2499)).padStart(5,'0'),
         pick(expenseAccounts).id || 5900,
         `Preferred ${pick(['lumber','electrical','plumbing','HVAC','roofing','hardware','paint','flooring'])} vendor.`]
      );
    });
    console.log('  Vendors: 16');
  }

  // ── Jobs (18 → 36) ──
  if ((db.get('SELECT COUNT(*) as n FROM jobs WHERE mock=1') || {}).n >= 36) {
    console.log('  Jobs: already doubled');
  } else {
    const allCust = db.all('SELECT id, name FROM customers WHERE mock=1 ORDER BY id');
    const statuses = ['estimating','scheduled','in_progress','complete','cancelled'];
    const jobTitles = [
      'Full kitchen remodel', 'Bathroom addition 2nd flr', 'Basement waterproofing',
      'Deck & patio build', 'Garage conversion ADU', 'Solar panel installation',
      'Masonry retaining wall', 'Window replacement (12 units)', 'Siding & trim',
      'Landscape hardscaping', 'Commercial storefront TI', 'Fire damage restoration',
      'Elevator shaft build', 'Pool house construction', 'Generator standby install',
      'Security system wiring', 'Sprinkler system install', 'Attic insulation & venting'
    ];
    const customers12 = allCust.slice(0, Math.min(12, allCust.length));
    const customers24 = allCust.slice(12);
    jobTitles.forEach((title, i) => {
      const cust = i < 12 ? customers12[i % customers12.length] : (customers24[i % customers24.length] || customers12[i % customers12.length]);
      if (!cust) return;
      const addr = `${randInt(100,9999)} ${pick(['Main','Oak','Elm','Park','River','High','Pine','Maple','Cedar','Birch'])} ${pick(['St','Ave','Dr','Lane','Way','Blvd'])}`;
      const d = String(randInt(1,28)).padStart(2,'0');
      db.run(`INSERT INTO jobs (customer_id, title, address, city, state, zip, description, status, scheduled_date, created_at, updated_at, mock)
        VALUES (?, ?, ?, ?, 'MA', ?, ?, ?, ?, ?, ?, 1)`,
        [cust.id, title, addr, pick(['Boston','Cambridge','Somerville','Quincy','Newton']),
         String(randInt(2100,2499)).padStart(5,'0'),
         `${title} at ${cust.name} — scope TBD.`,
         pick(statuses),
         `2026-0${randInt(4,5)}-${d}`,
         `2026-0${randInt(3,4)}-${d} 00:00:00`,
         `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`]
      );
    });
    console.log('  Jobs: 36');
  }

  const allJobs = db.all('SELECT id FROM jobs WHERE mock=1 ORDER BY id');
  const jobs18 = allJobs.slice(0, Math.min(18, allJobs.length));
  const jobs36 = allJobs.slice(18);

  // ── Work Orders (22 → 44) ──
  if ((db.get('SELECT COUNT(*) as n FROM work_orders WHERE mock=1') || {}).n >= 44) {
    console.log('  WOs: already doubled');
  } else {
    const users = db.all('SELECT id, name FROM users WHERE active=1');
    const woStatuses = ['scheduled','in_progress','complete','cancelled'];
    // Create 36 root WOs (18 new)
    for (let i = 0; i < 18; i++) {
      const job = jobs36[i] || jobs18[i % jobs18.length];
      if (!job) continue;
      const main = String(19 + i).padStart(4, '0');
      const user = pick(users);
      const status = pick(woStatuses);
      const sched = `2026-05-${String(randInt(10,24)).padStart(2,'0')}`;
      const woId = db.run(`INSERT INTO work_orders (job_id, wo_number_main, wo_number_sub, display_number, status, scheduled_date, scheduled_time, assigned_to, assigned_to_user_id, created_at, updated_at, mock)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)`,
        [job.id, main, `${main}-0000`, status, sched,
         `${String(randInt(7,16)).padStart(2,'0')}:00`,
         user.name, user.id]).lastInsertRowid;

      // Line items (2-5)
      for (let li = 0; li < randInt(2,5); li++) {
        db.run(`INSERT INTO work_order_line_items (work_order_id, description, quantity, unit, unit_price, cost, line_total, completed, sort_order, mock)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [woId, pick(['Demolition','Framing','Drywall','Paint','Trim','Flooring','Cabinets','Countertop','Tile','Plumbing','Electrical','HVAC','Insulation','Roofing','Siding']),
           randInt(1,10), pick(['ea','hr','sqft','lf','lot']), rprice(50,5000), rprice(25,2500), 0,
           Math.random() > 0.6 ? 1 : 0, li]);
      }
    }
    // Create 8 sub-WOs (4 new)
    for (let i = 0; i < 4; i++) {
      const parent = db.get('SELECT id, wo_number_main FROM work_orders WHERE mock=1 AND parent_wo_id IS NULL ORDER BY RANDOM() LIMIT 1');
      if (!parent) continue;
      const user = pick(users);
      const sub = String(5 + i).padStart(4, '0');
      db.run(`INSERT INTO work_orders (job_id, parent_wo_id, wo_number_main, wo_number_sub, display_number, status, scheduled_date, assigned_to, assigned_to_user_id, created_at, updated_at, mock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)`,
        [db.get('SELECT job_id FROM work_orders WHERE id=?', [parent.id]).job_id, parent.id,
         parent.wo_number_main, sub, `${parent.wo_number_main}-${sub}`, pick(['scheduled','in_progress']),
         `2026-05-${String(randInt(12,24)).padStart(2,'0')}`, user.name, user.id]);
    }
    console.log('  WOs: 44 (36 root + 8 sub)');
  }

  // ── Estimates (14 → 28) ──
  if ((db.get('SELECT COUNT(*) as n FROM estimates WHERE mock=1') || {}).n >= 28) {
    console.log('  Estimates: already doubled');
  } else {
    const newWos = db.all('SELECT id FROM work_orders WHERE mock=1 ORDER BY id').slice(22);
    const estStatuses = ['draft','sent','accepted','rejected'];
    newWos.forEach((wo, i) => {
      const s = pick(estStatuses);
      const subtotal = rprice(500, 25000);
      const tax = subtotal * TAX_RATE / 100;
      const cost = rprice(200, 12000);
      const estId = db.run(`INSERT INTO estimates (work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, valid_until, sent_at, accepted_at, created_at, updated_at, mock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [wo.id, s, subtotal, TAX_RATE, tax, subtotal + tax, cost,
         `2026-0${randInt(5,6)}-${String(randInt(1,30)).padStart(2,'0')}`,
         s !== 'draft' ? `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00` : null,
         s === 'accepted' ? `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00` : null,
         `2026-0${randInt(3,4)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`,
         `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`]).lastInsertRowid;
      // Line items (2-4)
      for (let li = 0; li < randInt(2,4); li++) {
        db.run(`INSERT INTO estimate_line_items (estimate_id, description, quantity, unit, unit_price, cost, line_total, selected, sort_order, mock)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [estId, pick(['Labor — rough-in','Materials','Permit fee','Disposal','Equipment rental','Subcontractor','Consulting','Travel']),
           randInt(1,5), pick(['ea','hr','sqft','lf','lot']), rprice(100, 5000), rprice(50, 2500),
           rprice(100, 5000), 1, li]);
      }
    });
    console.log('  Estimates: 28');
  }

  // ── Invoices (7 → 14) ──
  if ((db.get('SELECT COUNT(*) as n FROM invoices WHERE mock=1') || {}).n >= 14) {
    console.log('  Invoices: already doubled');
  } else {
    const acceptedEsts = db.all('SELECT e.id, e.total, e.subtotal, e.tax_amount, e.work_order_id FROM estimates e WHERE e.mock=1 AND e.status IN (\'accepted\',\'sent\') ORDER BY e.id').slice(14);
    acceptedEsts.forEach((est, i) => {
      const invStatus = i < 3 ? pick(['sent','paid']) : pick(['draft','sent']);
      const paid = invStatus === 'paid' ? est.total : 0;
      const invId = db.run(`INSERT INTO invoices (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, amount_paid, due_date, sent_at, paid_at, created_at, updated_at, mock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [est.id, est.work_order_id, invStatus, est.subtotal, TAX_RATE, est.tax_amount, est.total, paid,
         `2026-0${randInt(5,6)}-${String(randInt(1,30)).padStart(2,'0')}`,
         invStatus !== 'draft' ? `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00` : null,
         paid > 0 ? `2026-0${randInt(5,5)}-${String(randInt(1,10)).padStart(2,'0')} 00:00:00` : null,
         `2026-0${randInt(3,4)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`,
         `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')} 00:00:00`]).lastInsertRowid;
      // Post JEs if sent/paid
      if (invStatus !== 'draft') {
        try { posting.postInvoiceSent(invId, 1); } catch(e) { /* JE may exist */ }
      }
      if (paid > 0) {
        try { posting.postInvoicePayment(invId, paid, 1); } catch(e) {}
      }
    });
    console.log('  Invoices: 14');
  }

  // ── Bills (12 → 24) ──
  if ((db.get('SELECT COUNT(*) as n FROM bills WHERE mock=1') || {}).n >= 24) {
    console.log('  Bills: already doubled');
  } else {
    const allVendors = db.all('SELECT id, default_expense_account_id FROM vendors WHERE mock=1 ORDER BY id');
    const vendors8 = allVendors.slice(0, 8);
    const vendors16 = allVendors.slice(8);
    const bs = ['draft','approved','paid','void'];
    for (let i = 0; i < 12; i++) {
      const v = i < 8 ? (vendors8[i] || pick(vendors8)) : (vendors16[i - 8] || pick(vendors16));
      const s = pick(bs);
      const sub = rprice(500, 20000);
      const tax = rprice(10, 500);
      const total = sub + tax;
      const paid = s === 'paid' ? total : 0;
      const billId = db.run(`INSERT INTO bills (vendor_id, bill_number, status, bill_date, due_date, subtotal, tax_amount, total, amount_paid, created_at, updated_at, mock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)`,
        [v.id, `MOCK-BILL-${100 + i}`, s, `2026-0${randInt(4,5)}-${String(randInt(1,28)).padStart(2,'0')}`,
         `2026-0${randInt(5,6)}-${String(randInt(1,28)).padStart(2,'0')}`, sub, tax, total, paid]).lastInsertRowid;
      // Line items
      for (let li = 0; li < randInt(1,3); li++) {
        db.run(`INSERT INTO bill_lines (bill_id, account_id, description, quantity, unit_price, line_total, sort_order, mock)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [billId, v.default_expense_account_id || 5900, pick(['Materials','Supplies','Equipment','Labor','Subcontractor','Permit','Transport']),
           randInt(1,5), rprice(100, 5000), 0, li]);
      }
      // Post JE if approved/paid
      if (s === 'approved' || s === 'paid') {
        try { posting.postBillApproved(billId, 1); } catch(e) {}
      }
      if (s === 'paid') {
        try { posting.postBillPayment(billId, total, 1); } catch(e) {}
      }
    }
    console.log('  Bills: 24');
  }

  // ── Items library (25 → 50) ──
  if ((db.get('SELECT COUNT(*) as n FROM items_library WHERE mock=1') || {}).n >= 50) {
    console.log('  Items library: already doubled');
  } else {
    const newItems = [
      'Baseboard removal per LF', 'Carpet removal per SF', 'Tile demo per SF',
      'Concrete demo per CY', 'Asbestos abatement per SF', 'Lead paint remediation per SF',
      'Scaffolding rental per day', 'Skip bin rental per week', 'Porta-potty rental per week',
      'Temp power pole install', 'Generator rental per day', 'Compressor rental per day',
      'Chop saw rental per day', 'Miter saw — compound', 'Table saw rental per day',
      'Post-hole auger rental', 'Jackhammer rental per day', 'Concrete mixer rental per day',
      'Forklift rental per hour', 'Boom lift rental per day', 'Scissor lift rental per day',
      'Telehandler rental per day', 'Mini-excavator rental per day', 'Skid steer rental per day',
      'Dump truck load per trip'
    ];
    newItems.forEach(desc => {
      db.run(`INSERT INTO items_library (description, quantity, unit, unit_price, cost, category, created_at, mock)
        VALUES (?, 1, ?, ?, ?, ?, datetime('now'), 1)`,
        [desc, pick(['ea','hr','day','week','SF','LF','CY','ton']), rprice(25, 500), rprice(10, 250),
         pick(['Rental','Demolition','Temp','Equipment'])]);
    });
    console.log('  Items library: 50');
  }

  // ── wo_notes (today-dated: 8 → 16) ──
  if ((db.get('SELECT COUNT(*) as n FROM wo_notes WHERE mock=1') || {}).n >= 16) {
    console.log('  wo_notes: already doubled');
  } else {
    const todayWos = db.all('SELECT id, display_number FROM work_orders WHERE mock=1 AND scheduled_date = ? ORDER BY RANDOM() LIMIT 8', [TODAY]);
    const users = db.all('SELECT id, name FROM users WHERE active=1');
    const noteTexts = [
      'Material delivery received — stacked in garage.',
      'Electrical sub finished rough-in. Inspection tomorrow.',
      'Client stopped by, requested change to cabinet layout.',
      'Plumbing inspection failed — fixing vent stack. Rescheduled.',
      'Framing inspection passed. Insulation crew starts tomorrow.',
      'HVAC rough-in complete. Ductwork sealed and taped.',
      'Discovered rot in subfloor — need structural engineer consult.',
      'All windows installed. Exterior trim goes on tomorrow.'
    ];
    todayWos.forEach((wo, i) => {
      const user = pick(users);
      const h = String(7 + i).padStart(2, '0');
      db.run(`INSERT INTO wo_notes (work_order_id, user_id, body, created_at, mock)
        VALUES (?, ?, ?, ?, 1)`,
        [wo.id, user.id, noteTexts[i % noteTexts.length],
         `${TODAY} ${h}:${String(randInt(0,59)).padStart(2,'0')}:00`]);

      // Add a second note for some WOs
      if (i % 2 === 0) {
        db.run(`INSERT INTO wo_notes (work_order_id, user_id, body, created_at, mock)
          VALUES (?, ?, ?, ?, 1)`,
          [wo.id, pick(users).id, `Follow-up: ${pick(['Permit pulled.','Change order submitted.','Material ordered.','Schedule moved up.'])}`,
           `${TODAY} ${String(parseInt(h)+2).padStart(2,'0')}:${String(randInt(0,59)).padStart(2,'0')}:00`]);
      }
    });
    console.log('  wo_notes: ~16');
  }

  console.log('');
}

// ── Print summary ──
function printSummary() {
  console.log('\n=== Doubled Mock Data Summary ===');
  const tables = [
    ['Items library', 'items_library'],
    ['Customers', 'customers'],
    ['Vendors', 'vendors'],
    ['Jobs', 'jobs'],
    ['Work Orders', 'work_orders'],
    ['Estimates', 'estimates'],
    ['Invoices', 'invoices'],
    ['Bills', 'bills'],
    ['wo_notes', 'wo_notes'],
  ];
  tables.forEach(([label, table]) => {
    const total = (db.get(`SELECT COUNT(*) as n FROM ${table}`) || {}).n || 0;
    const mock = (db.get(`SELECT COUNT(*) as n FROM ${table} WHERE mock=1`) || {}).n || 0;
    console.log(`  ${label}: ${total} (${mock} mock)`);
  });
  // Trial balance
  const accts = db.all(`SELECT a.code, a.name, a.type,
    COALESCE(SUM(jl.debit),0) as tot_dr, COALESCE(SUM(jl.credit),0) as tot_cr
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
    GROUP BY a.id`);
  let totalDr=0, totalCr=0;
  accts.forEach(a => { totalDr+=a.tot_dr; totalCr+=a.tot_cr; });
  console.log(`  Trial Balance: Dr $${totalDr.toFixed(2)} = Cr $${totalCr.toFixed(2)}${Math.abs(totalDr-totalCr)<0.01 ? ' ✅' : ' ❌'}`);
  console.log(`  Journal entries: ${db.get('SELECT COUNT(*) AS n FROM journal_entries').n}`);
  console.log('');
}

// ── Main ──
(async () => {
  try {
    await db.init();
    if (RESET_FLAG) {
      resetDoubleData();
      db.persist();
      console.log('Reset complete. Re-run without --reset to double data.');
      setTimeout(() => process.exit(0), 200);
      return;
    }
    // Check if already doubled
    const itemsCount = (db.get('SELECT COUNT(*) as n FROM items_library WHERE mock=1') || {}).n || 0;
    if (itemsCount >= 50) {
      console.log('Mock data already doubled. Use --reset to re-run.');
    } else {
      doubleData();
    }
    printSummary();
  } catch (err) {
    console.error('Seed double failed:', err);
    process.exit(1);
  }
  db.persist();
  setTimeout(() => process.exit(0), 300);
})();
