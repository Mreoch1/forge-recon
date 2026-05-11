/**
 * seed-mock.js — Idempotent mock data seeder for the construction WO system.
 *
 * Usage:
 *   npm run seed:mock           # seed if not already seeded
 *   npm run seed:mock -- --reset  # delete mock data + reseed
 *
 * Creates realistic data across every domain with balanced JEs via
 * the accounting-posting service functions.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('./db');
const calc = require('../services/calculations');
const numbering = require('../services/numbering');
const posting = require('../services/accounting-posting');
const { writeAudit } = require('../services/audit');

const RESET_FLAG = process.argv.includes('--reset');
const SENTINEL_NAME = 'Cambridge Towers Property Mgmt';
const TAX_RATE = 6.25; // MA default
const TODAY = '2026-05-10';

// ── Migration: add mock column to domain tables ──────────────────────
function migrate() {
  const tables = ['customers','vendors','jobs','work_orders','estimates','invoices','bills','estimate_line_items','work_order_line_items','invoice_line_items','bill_lines','wo_notes','items_library','audit_logs'];
  let migrated = 0;
  tables.forEach(t => {
    const cols = db.all(`PRAGMA table_info(${t})`).map(c => c.name);
    if (!cols.includes('mock')) {
      db.run(`ALTER TABLE ${t} ADD COLUMN mock INTEGER NOT NULL DEFAULT 0`);
      migrated++;
    }
  });
  // Create pending_confirmations table if not exists
  db.run(`CREATE TABLE IF NOT EXISTS pending_confirmations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`);
  if (migrated) console.log(`  Schema: added mock column to ${migrated} table(s).`);
  else console.log('  Schema: mock column already present on all tables.');
}

// ── Sentinel ─────────────────────────────────────────────────────────
function isAlreadySeeded() {
  const r = db.get('SELECT COUNT(*) AS n FROM customers WHERE mock = 1 AND name = ?', [SENTINEL_NAME]);
  return r && r.n > 0;
}

// ── Reset ────────────────────────────────────────────────────────────
function resetMockData() {
  if (!isAlreadySeeded()) {
    console.log('  No mock data found. Nothing to reset.');
    return;
  }
  const order = ['bill_lines','bills','invoice_line_items','invoices','estimate_line_items','estimates','wo_notes','audit_logs','work_order_line_items','work_orders','jobs','customers','vendors','items_library'];
  let total = 0;
  order.forEach(t => {
    const r = db.run(`DELETE FROM ${t} WHERE mock = 1`);
    total += r.changes;
  });
  // Delete JEs linked to mock bills/invoices — these were created by accounting-posting
  // during the seed run and reference source_type 'bill' or 'bill_payment' or mock invoice IDs.
  const mockJeIds = db.all(`SELECT DISTINCT je.id FROM journal_entries je
    WHERE je.source_type IN ('bill','bill_payment','invoice','payment','invoice_void')
    AND je.source_id IN (SELECT id FROM bills WHERE mock = 1
      UNION ALL SELECT id FROM invoices WHERE mock = 1)`);
  const allJeIds = [...new Set(mockJeIds.map(j => j.id))];
  allJeIds.forEach(jeId => {
    db.run('DELETE FROM journal_lines WHERE journal_entry_id = ?', [jeId]);
    db.run('DELETE FROM journal_entries WHERE id = ?', [jeId]);
  });
  console.log(`  Cleaned ${allJeIds.length} orphaned journal entries.`);
  // Also delete users with mock role
  db.run("DELETE FROM users WHERE role = 'worker' AND id > 1");
  // Reset numbering counters to 1
  db.run('UPDATE company_settings SET next_wo_main_number = 1');
  console.log(`  Reset complete. Deleted mock rows from ${order.length} tables.`);
}

// ── Date helpers ─────────────────────────────────────────────────────
function ago(days) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - days);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
function future(days) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Data pools ───────────────────────────────────────────────────────
const FIRST_NAMES = ['James','Maria','Carlos','Sarah','David','Emily','Michael','Aisha','Tyrell','Sam','Luis','Keisha','Derek','Vanessa','Raj'];
const LAST_NAMES = ['O\'Brien','Martinez','Washington','Chen','Patel','Johnson','Kim','Garcia','Thompson','Lee','Rossi','Nguyen','Brown','Park','Miller'];

  const WORKER_NAMES = [
    { name: 'Mike Kowalski', role: 'manager', phone: '(617) 555-0101' },
    { name: 'Carlos Mendez', role: 'worker', phone: '(617) 555-0102' },
    { name: 'Dave Thompson', role: 'worker', phone: '(617) 555-0103' },
    { name: 'Tyrell Jones',  role: 'worker', phone: '(617) 555-0104' },
    { name: 'Sam Hartley',   role: 'worker', phone: '(617) 555-0105' },
  ];

const CUSTOMERS = [
  {name:'Cambridge Towers Property Mgmt', email:'office@cambridgetowers.com',  phone:'617-555-0101', city:'Cambridge', state:'MA', zip:'02138', notes:'Property management — 12-unit building'},
  {name:'MacKenzie Homes LLC',            email:'info@mackenziehomes.com',      phone:'617-555-0102', city:'Newton',    state:'MA', zip:'02458', notes:'General contractor, new builds'},
  {name:'Beacon Hill Restoration',        email:'bob@beaconhillrestore.com',    phone:'617-555-0103', city:'Boston',    state:'MA', zip:'02114', notes:'Historical home specialist'},
  {name:'Northeast General Contractors',  email:'dispatch@negc.com',            phone:'781-555-0104', city:'Quincy',   state:'MA', zip:'02169', notes:'Commercial GC'},
  {name:'The O\'Brien Family',            email:'pat.obrien@gmail.com',          phone:'617-555-0105', city:'Boston',    state:'MA', zip:'02127', notes:'South Boston townhouse'},
  {name:'Allston Veterinary Clinic',      email:'frontdesk@allstonvet.com',     phone:'617-555-0106', city:'Allston',  state:'MA', zip:'02134', notes:'Commercial — vet office'},
  {name:'Riverside Condo Association',    email:'hoadmin@riversidecondo.com',   phone:'857-555-0107', city:'Cambridge', state:'MA', zip:'02139', notes:'HOA — 40 units'},
  {name:'Smith & Warren Builders',        email:'estimating@smithwarren.com',   phone:'781-555-0108', city:'Newton',    state:'MA', zip:'02462', notes:'Residential builder'},
  {name:'Prudential Medical Plaza',       email:'facilities@pruplaza.com',      phone:'617-555-0109', city:'Boston',    state:'MA', zip:'02199', notes:'Commercial medical office'},
  {name:'Harborview Apartments LLC',      email:'mgmt@harborview.com',          phone:'617-555-0110', city:'Quincy',    state:'MA', zip:'02170', notes:'Waterfront apartment complex'},
  {name:'Mrs. Eleanor Whitaker',          email:'ewhitaker@verizon.net',        phone:'617-555-0111', city:'Cambridge', state:'MA', zip:'02140', notes:'Elderly homeowner, single-family'},
  {name:'TechSquare Labs',                email:'ops@techsquare.co',            phone:'857-555-0112', city:'Boston',    state:'MA', zip:'02210', notes:'Innovation hub — Seaport'},
];

const VENDORS = [
  {name:'Brockton Lumber Co.',          email:'orders@brocktonlumber.com',     phone:'508-555-0201', city:'Brockton', state:'MA', zip:'02301', default_expense_account_id:18},
  {name:'Eastern Electrical Supply',    email:'sales@easternelectric.com',     phone:'617-555-0202', city:'Boston',   state:'MA', zip:'02128', default_expense_account_id:18}, // falls back to 5300
  {name:'Apex HVAC Wholesale',          email:'parts@apexhvac.com',            phone:'781-555-0203', city:'Woburn',   state:'MA', zip:'01801', default_expense_account_id:18},
  {name:'Reliable Dumpster Service',    email:'dispatch@reliabledumpster.com', phone:'617-555-0204', city:'Quincy',   state:'MA', zip:'02171', default_expense_account_id:20},
  {name:'ProSite Equipment Rental',     email:'rentals@prositeequip.com',      phone:'781-555-0205', city:'Newton',   state:'MA', zip:'02464', default_expense_account_id:22},
  {name:'Pioneer Plumbing Supply',      email:'sales@pioneerplumb.com',        phone:'617-555-0206', city:'Boston',   state:'MA', zip:'02122', default_expense_account_id:19},
  {name:'East Coast Fuel & Transport',  email:'fuel@eastcoastfuel.com',        phone:'857-555-0207', city:'Revere',   state:'MA', zip:'02151', default_expense_account_id:23},
  {name:'SafetyFirst Insurance Agency', email:'claims@safetyfirstins.com',     phone:'617-555-0208', city:'Boston',   state:'MA', zip:'02110', default_expense_account_id:23},
];

const ITEMS_LIBRARY = [
  {desc:'Demolition — interior (per room)',            category:'demo',       qty:1, unit:'ea', price:1200, cost:600},
  {desc:'Demolition — full gut (per 100 SF)',          category:'demo',       qty:1, unit:'ea', price:2500, cost:1200},
  {desc:'Framing — interior walls (per LF)',           category:'framing',    qty:1, unit:'lf',  price:28,   cost:14},
  {desc:'Framing — load bearing wall',                 category:'framing',    qty:1, unit:'ea',  price:950,  cost:450},
  {desc:'Drywall — hang & finish (per sheet)',         category:'drywall',    qty:1, unit:'ea',  price:85,   cost:42},
  {desc:'Drywall — repair patch (small)',              category:'drywall',    qty:1, unit:'ea',  price:150,  cost:65},
  {desc:'Taping & mudding (per room)',                 category:'drywall',    qty:1, unit:'ea',  price:350,  cost:180},
  {desc:'Paint — interior (per room)',                 category:'paint',      qty:1, unit:'ea',  price:450,  cost:200},
  {desc:'Paint — exterior (per 100 SF)',               category:'paint',      qty:1, unit:'sqft',price:4.50, cost:2},
  {desc:'Electrical — outlet/switch (each)',           category:'electrical', qty:1, unit:'ea',  price:85,   cost:35},
  {desc:'Electrical — light fixture install',          category:'electrical', qty:1, unit:'ea',  price:120,  cost:55},
  {desc:'Electrical — panel upgrade 200A',             category:'electrical', qty:1, unit:'ea',  price:2800, cost:1400},
  {desc:'Plumbing — sink rough-in',                    category:'plumbing',   qty:1, unit:'ea',  price:650,  cost:300},
  {desc:'Plumbing — toilet install',                   category:'plumbing',   qty:1, unit:'ea',  price:250,  cost:110},
  {desc:'Plumbing — water heater replacement',         category:'plumbing',   qty:1, unit:'ea',  price:1800, cost:900},
  {desc:'HVAC — duct cleaning (per vent)',             category:'hvac',       qty:1, unit:'ea',  price:45,   cost:20},
  {desc:'HVAC — mini-split install',                   category:'hvac',       qty:1, unit:'ea',  price:4200, cost:2000},
  {desc:'Flooring — LVP install (per SF)',             category:'flooring',   qty:1, unit:'sqft',price:6.50, cost:3.25},
  {desc:'Flooring — tile install (per SF)',             category:'flooring',   qty:1, unit:'sqft',price:12,   cost:6},
  {desc:'Cabinetry — base cabinet (per LF)',           category:'cabinetry',  qty:1, unit:'lf',  price:250,  cost:120},
  {desc:'Cabinetry — upper cabinet (per LF)',           category:'cabinetry',  qty:1, unit:'lf',  price:200,  cost:95},
  {desc:'Countertop — laminate (per SF)',              category:'cabinetry',  qty:1, unit:'sqft',price:35,   cost:15},
  {desc:'Countertop — quartz (per SF)',                category:'cabinetry',  qty:1, unit:'sqft',price:85,   cost:42},
  {desc:'Roofing — asphalt shingle (per SQ)',          category:'roofing',    qty:1, unit:'ea',  price:950,  cost:480},
  {desc:'Roofing — repair patch',                      category:'roofing',    qty:1, unit:'ea',  price:450,  cost:200},
];

const JOBS = [
  {title:'Kitchen renovation — Apt 3B',                              custIdx:0,  status:'in_progress', address:'10 Cambridge Pkwy Apt 3B', city:'Cambridge', state:'MA', zip:'02138'},
  {title:'Bathroom remodel — second floor',                          custIdx:4,  status:'scheduled',    address:'42 Dorchester St',        city:'Boston',    state:'MA', zip:'02127'},
  {title:'Storm damage roof repair — garage',                        custIdx:10, status:'estimating',   address:'158 Huron Ave',           city:'Cambridge', state:'MA', zip:'02140'},
  {title:'Office tenant improvement — 3rd floor',                    custIdx:11, status:'in_progress', address:'12 Seaport Blvd',         city:'Boston',    state:'MA', zip:'02210'},
  {title:'Emergency plumbing — burst pipe',                          custIdx:8,  status:'complete',     address:'800 Boylston St',         city:'Boston',    state:'MA', zip:'02199'},
  {title:'Exterior paint — 2-family',                                custIdx:5,  status:'estimating',   address:'100 Harvard Ave',        city:'Allston',   state:'MA', zip:'02134'},
  {title:'HVAC replacement — common area',                           custIdx:6,  status:'scheduled',    address:'50 River St',             city:'Cambridge', state:'MA', zip:'02139'},
  {title:'Tenant fit-out — Suite 200',                               custIdx:3,  status:'in_progress', address:'1250 Hancock St',        city:'Quincy',    state:'MA', zip:'02169'},
  {title:'Cabinetry + countertops — new spec home',                  custIdx:1,  status:'scheduled',    address:'75 Cherry Ln',           city:'Newton',    state:'MA', zip:'02458'},
  {title:'Electrical panel upgrade',                                 custIdx:9,  status:'complete',     address:'200 Marina Bay Dr',      city:'Quincy',    state:'MA', zip:'02170'},
  {title:'Water heater replacement',                                 custIdx:4,  status:'cancelled',    address:'42 Dorchester St',       city:'Boston',    state:'MA', zip:'02127'},
  {title:'Historic window restoration — 3 units',                    custIdx:2,  status:'scheduled',    address:'25 Chestnut St',         city:'Boston',    state:'MA', zip:'02114'},
  {title:'Medical office build-out — ground floor',                  custIdx:8,  status:'estimating',   address:'800 Boylston St Suite G', city:'Boston',   state:'MA', zip:'02199'},
  {title:'Deck & porch rebuild',                                     custIdx:10, status:'scheduled',    address:'158 Huron Ave',          city:'Cambridge', state:'MA', zip:'02140'},
  {title:'Leak remediation — Unit 12',                               custIdx:6,  status:'in_progress', address:'50 River St Unit 12',    city:'Cambridge', state:'MA', zip:'02139'},
  {title:'New construction — 3-family townhomes (Phase 1)',          custIdx:1,  status:'estimating',   address:'15 Maple St',            city:'Newton',    state:'MA', zip:'02458'},
  {title:'Fire damage restoration — kitchen',                        custIdx:7,  status:'in_progress', address:'300 Washington St',     city:'Newton',    state:'MA', zip:'02462'},
  {title:'ADA bathroom upgrade — 2nd floor',                         custIdx:3,  status:'scheduled',    address:'1250 Hancock St',        city:'Quincy',    state:'MA', zip:'02169'},
];

const WO_STATUSES = ['scheduled','scheduled','in_progress','in_progress','complete','complete','scheduled','in_progress','scheduled','complete','cancelled','scheduled','estimating','scheduled','in_progress','estimating','in_progress','scheduled'];
const EST_STATUSES = ['draft','sent','accepted','accepted','sent','accepted','accepted','accepted','draft','accepted','rejected','sent','draft','accepted','draft','expired'];

const TODAY_TIMES = ['08:00','10:30','13:00','15:30','09:00','11:00','14:00','07:30'];
const ASSIGNEE_NAMES = ['Mike Kowalski','Carlos Mendez','Dave Thompson','Tyrell Jones','Sam Hartley','Mike Kowalski + Carlos','Dave + Tyrell','Sam + Mike'];

// ── Pick helpers ─────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) { const s = [...arr].sort(()=>Math.random()-0.5); return s.slice(0,n); }
function rng(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function rngDec(min, max, fixed=2) { return parseFloat((Math.random() * (max - min) + min).toFixed(fixed)); }

// ── Core seed ────────────────────────────────────────────────────────
async function seedMock() {
  console.log('\n=== Mock Data Seeder ===\n');

  // ── Setup ──
  migrate();

  if (isAlreadySeeded() && !RESET_FLAG) {
    console.log(`Sentinel customer "${SENTINEL_NAME}" exists.`);
    console.log('Mock data already present. Use --reset to reseed.\n');
    return;
  }

  if (RESET_FLAG) resetMockData();

  console.log('Seeding mock data...\n');

  // ── 1. Items library (25) ──
  let itemsInserted = 0;
  ITEMS_LIBRARY.forEach(item => {
    const existing = db.get('SELECT id FROM items_library WHERE description = ? AND archived = 0', [item.desc]);
    if (!existing) {
      db.run(`INSERT INTO items_library (description, quantity, unit, unit_price, cost, category, created_at)
              VALUES (?, ?, ?, ?, ?, ?, now())`,
        [item.desc, item.qty, item.unit, item.price, item.cost, item.category]);
      itemsInserted++;
    }
  });
  // Get all items for lookups
  const allItems = db.all('SELECT * FROM items_library WHERE archived = 0');

  // ── 2. Users (add 1 manager + 4 workers) ──
  const bcrypt = require('bcryptjs');
  let userCount = 0;
  WORKER_NAMES.forEach(u => {
    const existing = db.get('SELECT id FROM users WHERE email = ?', [u.name.toLowerCase().replace(' ','.')+'@recon.local']);
    if (!existing) {
      const hash = bcrypt.hashSync('changeme123', 10);
      db.run(`INSERT INTO users (email, password_hash, name, role, phone, active, created_at)
              VALUES (?, ?, ?, ?, ?, 1, now())`,
        [u.name.toLowerCase().replace(' ','.')+'@recon.local', hash, u.name, u.role, u.phone]);
      userCount++;
    }
  });
  const allUsers = db.all('SELECT id, name, role FROM users WHERE active = 1');

  // ── 3. Customers (12) ──
  let custCount = 0;
  const custIds = [];
  CUSTOMERS.forEach(c => {
    const existing = db.get('SELECT id FROM customers WHERE name = ?', [c.name]);
    if (!existing) {
      const r = db.run(`INSERT INTO customers (name, email, phone, address, city, state, zip, notes, mock, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [c.name, c.email, c.phone, c.address || '123 Main St', c.city, c.state, c.zip, c.notes, ago(rng(10,60))]);
      custIds.push(r.lastInsertRowid);
    } else {
      custIds.push(existing.id);
    }
  });
  custCount = custIds.length;

  // ── 4. Vendors (8) ──
  let vendCount = 0;
  const vendIds = [];
  VENDORS.forEach(v => {
    const existing = db.get('SELECT id FROM vendors WHERE name = ?', [v.name]);
    if (!existing) {
      const r = db.run(`INSERT INTO vendors (name, email, phone, address, city, state, zip, default_expense_account_id, notes, mock, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [v.name, v.email, v.phone, '150 Industrial Blvd', v.city, v.state, v.zip, v.default_expense_account_id, v.name, ago(rng(10,60))]);
      vendIds.push(r.lastInsertRowid);
    } else {
      vendIds.push(existing.id);
    }
  });
  vendCount = vendIds.length;

  // ── 5. Jobs (18) ──
  let jobCount = 0;
  const jobIds = [];
  JOBS.forEach((j, idx) => {
    const existing = db.get('SELECT id FROM jobs WHERE title = ? AND customer_id = ?', [j.title, custIds[j.custIdx]]);
    if (!existing) {
      const daysAgo = rng(5, 45);
      const r = db.run(`INSERT INTO jobs (customer_id, title, address, city, state, zip, status, description, mock, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [custIds[j.custIdx], j.title, j.address, j.city, j.state, j.zip, j.status, j.title, ago(daysAgo)]);
      jobIds.push(r.lastInsertRowid);
      jobCount++;
    } else {
      jobIds.push(existing.id);
    }
  });

  // ── 6. Work Orders (22: 18 root + 4 sub-WOs) ──
  let woCount = 0;
  const woIds = [];
  const woStatuses = ['scheduled','scheduled','in_progress','in_progress','complete','complete','scheduled','in_progress','scheduled','complete','cancelled','scheduled','scheduled','scheduled','in_progress','scheduled','in_progress','scheduled'];

  // Schedule distribution: today(4), tomorrow(5), next-14-days(8), past(5 completed)
  const schedDates = [
    '2026-05-10', '2026-05-10', '2026-05-10', '2026-05-10',
    '2026-05-11', '2026-05-11', '2026-05-11', '2026-05-11', '2026-05-11',
    '2026-05-12', '2026-05-14', '2026-05-16', '2026-05-18', '2026-05-20', '2026-05-22', '2026-05-24',
    '2026-05-13', '2026-05-15',
  ];

  jobIds.forEach((jid, idx) => {
    const status = woStatuses[idx];
    const existing = db.get('SELECT id FROM work_orders WHERE job_id = ? AND parent_wo_id IS NULL AND mock = 1', [jid]);
    if (existing) { woIds.push(existing.id); return; }

    const next = numbering.nextRootWoNumber();
    const sched = schedDates[idx] || '2026-05-10';
    const schedTime = (idx < 8) ? TODAY_TIMES[idx % TODAY_TIMES.length] : null;
    const assignee = (idx < 8) ? ASSIGNEE_NAMES[idx % ASSIGNEE_NAMES.length] : null;
    const completedDate = (status === 'complete') ? future(-rng(3, 14)) : null;
    const assignedTo = assignee || null;

    const r = db.run(`INSERT INTO work_orders
      (job_id, parent_wo_id, wo_number_main, wo_number_sub, display_number, status,
       scheduled_date, scheduled_time, scheduled_end_time, assigned_to, notes, completed_date, mock, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [jid, next.main, next.sub, next.display, status,
       sched, schedTime, schedTime ? (function(t){var p=t.split(':');var h=Math.min(parseInt(p[0],10)+2+Math.floor(Math.random()*3),18);return String(h).padStart(2,'0')+':'+p[1];})(schedTime) : null, assignedTo, null, completedDate,
       ago(rng(10,30)), ago(rng(5,15))]);
    const wid = r.lastInsertRowid;
    woIds.push(wid);
    woCount++;

    // Add line items (2-6 random items from library)
    const numLines = rng(2, 6);
    const pickedItems = pickN(allItems, numLines);
    pickedItems.forEach((item, li) => {
      const qty = rng(1, item.category === 'paint' ? 8 : 4);
      const lt = calc.lineTotal({quantity: qty, unit_price: item.unit_price});
      db.run(`INSERT INTO work_order_line_items (work_order_id, description, quantity, unit, unit_price, cost, line_total, completed, sort_order, mock)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [wid, item.description, qty, item.unit, item.unit_price, item.cost, lt, status === 'complete' ? 1 : 0, li]);
    });

    // Add wo_notes for some WOs
    const noteCount = Math.random() > 0.3 ? rng(1, 4) : 0;
    const noteTexts = [
      'Customer not home, left card.',
      'Need to come back for trim — ran out of material.',
      'Permit pulled — inspection Thursday AM.',
      'Replaced 2x fixtures, tested OK.',
      'Material delivery delayed by one day.',
      'Customer approved change order — adding extra outlet.',
      'Subcontractor on site for demo phase.',
      'Plywood subfloor needs replacing — communicated to PM.',
      'Electrician flagged outdated panel. Recommend upgrade.',
      'Paint color mis-match — customer picking new swatch.',
      'Framing inspection passed.',
      'Drywall delivery scheduled for tomorrow 7AM.',
      'Ventilation duct came loose. Re-secured and tested.',
      'Measured for countertops. Template sent to fabricator.',
      'Customer requesting add: closet shelving in master.',
      'Water shut off for plumbing work — resident notified.',
      'Disposal unit replaced under warranty.',
      'Roof patch held overnight. No leaks. Proceeding with shingles.',
      'Extra garbage haul needed — dumpster at 90%.',
      'Job site locked. Key under mat — access OK.',
    ];
    for (let n = 0; n < noteCount; n++) {
      db.run(`INSERT INTO wo_notes (work_order_id, user_id, body, created_at, mock)
              VALUES (?, ?, ?, ?, 1)`,
        [wid, allUsers[rng(0, allUsers.length-1)].id, pick(noteTexts), ago(rng(1, 20))]);
    }
  });

  // Add today-dated notes for timeline demo (at least 3 WOs with varied times)
  const todayDate = '2026-05-10';
  const todayNotes = [
    { woIdx: 0, timeIdx: 0, body: 'Cabinets delivered, framing looks good.', userIdx: 0 },
    { woIdx: 0, timeIdx: 1, body: 'Started demo — going smoothly.', userIdx: 0 },
    { woIdx: 0, timeIdx: 3, body: 'Customer stopped by, approved the layout.', userIdx: 1 },
    { woIdx: 2, timeIdx: 2, body: 'Roof patch held overnight. No leaks. Proceeding with shingles.', userIdx: 2 },
    { woIdx: 3, timeIdx: 0, body: 'Drywall delivery arrived. Crew on site.', userIdx: 1 },
    { woIdx: 3, timeIdx: 4, body: 'Framing inspection passed. Moving to electrical rough-in.', userIdx: 1 },
    { woIdx: 3, timeIdx: 5, body: 'Customer requested add: extra outlet in conference room.', userIdx: 0 },
    { woIdx: 7, timeIdx: 1, body: 'Subcontractor on site for demo phase.', userIdx: 3 },
  ];
  const todayTimes = ['08:14','09:32','10:14','11:22','13:05','14:30'];
  todayNotes.forEach(tn => {
    const wid = woIds[tn.woIdx];
    if (!wid) return;
    const uid = allUsers[tn.userIdx % allUsers.length].id;
    db.run(`INSERT INTO wo_notes (work_order_id, user_id, body, created_at, mock)
            VALUES (?, ?, ?, ?, 1)`,
      [wid, uid, tn.body, `${todayDate} ${todayTimes[tn.timeIdx]}:00`]);
  });

  // Add audit_log entries for today's WO status changes (started, completed)
  const todayAuditEvents = [
    { woIdx: 0, action: 'started', timeIdx: 1, userIdx: 1 },  // Mike (assigned to WO-0001)
    { woIdx: 2, action: 'started', timeIdx: 0, userIdx: 3 },  // Dave (assigned to WO-0003)
    { woIdx: 3, action: 'started', timeIdx: 2, userIdx: 4 },  // Tyrell (assigned to WO-0004)
    { woIdx: 7, action: 'started', timeIdx: 1, userIdx: 1 },  // Mike (assigned to WO-0008)
  ];
  todayAuditEvents.forEach(ae => {
    const wid = woIds[ae.woIdx];
    if (!wid) return;
    const uid = allUsers[ae.userIdx % allUsers.length].id;
    db.run(`INSERT INTO audit_logs (entity_type, entity_id, action, user_id, created_at, source)
            VALUES (?, ?, ?, ?, ?, ?)`,
      ['work_order', wid, ae.action, uid, `${todayDate} ${todayTimes[ae.timeIdx]}:00`, 'user']);
  });
  // Add mock=1 to the created audit entries so --reset catches them
  todayAuditEvents.forEach(ae => {
    const wid = woIds[ae.woIdx];
    if (!wid) return;
    db.run('UPDATE audit_logs SET mock = 1 WHERE entity_type = ? AND entity_id = ? AND action = ? AND date(created_at) = ?',
      ['work_order', wid, ae.action, todayDate]);
  });

  // ── 7. Sub-WOs (4) ──
  const parentIds = [woIds[1], woIds[3], woIds[7], woIds[14]];
  parentIds.forEach((pid, idx) => {
    const parent = db.get('SELECT * FROM work_orders WHERE id = ?', [pid]);
    if (!parent) return;
    const existing = db.get('SELECT id FROM work_orders WHERE parent_wo_id = ? AND mock = 1', [pid]);
    if (existing) return;

    const next = numbering.nextSubWoNumber(pid);
    const subStatus = idx < 2 ? 'scheduled' : 'in_progress';
    const r = db.run(`INSERT INTO work_orders
      (job_id, parent_wo_id, wo_number_main, wo_number_sub, display_number, status,
       scheduled_date, scheduled_time, scheduled_end_time, assigned_to, notes, mock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [parent.job_id, pid, next.main, next.sub, next.display, subStatus,
       future(rng(2,10)), TODAY_TIMES[idx+4 % 8], (function(t){var p=t.split(':');var h=Math.min(parseInt(p[0],10)+2+Math.floor(Math.random()*3),18);return String(h).padStart(2,'0')+':'+p[1];})(TODAY_TIMES[idx+4 % 8]), ASSIGNEE_NAMES[idx+2 % 8], null,
       ago(rng(3,8)), ago(rng(1,5))]);
    const swid = r.lastInsertRowid;
    const subItems = pickN(allItems, 2);
    subItems.forEach((item, li) => {
      const qty = rng(1, 3);
      const lt = calc.lineTotal({quantity: qty, unit_price: item.unit_price});
      db.run(`INSERT INTO work_order_line_items (work_order_id, description, quantity, unit, unit_price, cost, line_total, completed, sort_order, mock)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [swid, item.description, qty, item.unit, item.unit_price, item.cost, lt, 0, li]);
    });
    woCount++;
    woIds.push(swid);
  });

  // ── 8. Estimates (16) — from accepted and sent WOs ──
  let estCount = 0;
  const estIds = [];
  // Pick WOs to have estimates (use all non-cancelled, non-scheduled except first 2)
  const estTargets = woIds.filter((wid, idx) => {
    const wo = db.get('SELECT status, id FROM work_orders WHERE id = ?', [wid]);
    return wo && !['cancelled'].includes(wo.status) && idx % 3 !== 2;
  }).slice(0, 16);

  estTargets.forEach((wid, idx) => {
    const wo = db.get('SELECT * FROM work_orders WHERE id = ?', [wid]);
    if (!wo) return;
    const existing = db.get('SELECT id FROM estimates WHERE work_order_id = ? AND mock = 1', [wid]);
    if (existing) { estIds.push(existing.id); return; }

    const lines = db.all('SELECT * FROM work_order_line_items WHERE work_order_id = ?', [wid]);
    if (lines.length === 0) return;

    const tax = idx % 7 === 3 ? 0 : TAX_RATE; // some tax-exempt
    const totals = calc.totals(lines, tax);
    const costTotal = lines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);

    const estStatus = EST_STATUSES[idx] || 'draft';
    const sentAt = ['sent','accepted','rejected','expired'].includes(estStatus) ? ago(rng(2,14)) : null;
    const acceptedAt = ['accepted'].includes(estStatus) ? ago(rng(1,7)) : null;

    const r = db.run(`INSERT INTO estimates
      (work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, valid_until, notes, sent_at, accepted_at, mock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [wid, estStatus, totals.subtotal, tax, totals.taxAmount, totals.total, costTotal,
       estStatus === 'expired' ? future(-5) : future(rng(15, 45)),
       estStatus === 'rejected' ? 'Customer went with another contractor.' : null,
       sentAt, acceptedAt, ago(rng(5,25)), ago(rng(2,15))]);
    const eid = r.lastInsertRowid;
    estIds.push(eid);
    estCount++;

    // Copy lines with selected=1
    lines.forEach((li, lIdx) => {
      db.run(`INSERT INTO estimate_line_items (estimate_id, description, quantity, unit, unit_price, cost, line_total, selected, sort_order, mock)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
        [eid, li.description, li.quantity, li.unit, li.unit_price, li.cost, li.line_total, lIdx]);
    });
  });

  // ── 9. Invoices (10) — from accepted estimates ──
  let invCount = 0;
  const invIds = [];
  const acceptedEsts = db.all('SELECT * FROM estimates WHERE status = ? AND mock = 1 ORDER BY RANDOM()', ['accepted']);

  const INV_STATUSES = ['draft','sent','sent','paid','paid','paid','paid','paid','overdue','void'];
  acceptedEsts.slice(0, 10).forEach((est, idx) => {
    const existing = db.get('SELECT id FROM invoices WHERE estimate_id = ? AND mock = 1', [est.id]);
    if (existing) { invIds.push(existing.id); return; }

    const lines = db.all('SELECT * FROM estimate_line_items WHERE estimate_id = ? AND selected = 1', [est.id]);
    if (lines.length === 0) return;

    const invStatus = INV_STATUSES[idx] || 'draft';
    const totals = calc.totals(lines, est.tax_rate);
    const costTotal = lines.reduce((s, li) => s + (Number(li.cost) || 0) * (Number(li.quantity) || 0), 0);

    // Due date: overdue = past; sent varying; paid varies
    let dueDate;
    if (invStatus === 'overdue') dueDate = future(-rng(10, 25));
    else if (invStatus === 'paid') dueDate = future(-rng(5, 20));
    else if (invStatus === 'sent') dueDate = future(rng(5, 20));
    else dueDate = future(rng(10, 30));

    const paymentTerms = 'Net 30';
    const sentAt = (['sent','paid','overdue'].includes(invStatus)) ? ago(rng(5, 20)) : null;

    let amountPaid = 0;
    let paidAt = null;
    if (invStatus === 'paid') {
      // 3 of 5 paid are full, 2 had partial then full
      if (idx % 5 < 3) {
        amountPaid = totals.total;
        paidAt = ago(rng(1, 10));
      } else {
        amountPaid = totals.total;
        paidAt = ago(rng(1, 10));
      }
    } else if (invStatus === 'overdue') {
      // overdue might have partial
      amountPaid = 0;
    }

    const r = db.run(`INSERT INTO invoices
      (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, cost_total, amount_paid,
       payment_terms, due_date, sent_at, paid_at, notes, mock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [est.id, est.work_order_id, invStatus, totals.subtotal, est.tax_rate, totals.taxAmount, totals.total,
       costTotal, amountPaid, paymentTerms, dueDate, sentAt, paidAt,
       invStatus === 'void' ? 'Voided — customer dispute' : null,
       ago(rng(8, 20)), ago(rng(3, 12))]);
    const iid = r.lastInsertRowid;
    invIds.push(iid);
    invCount++;

    // Copy lines
    lines.forEach((li, lIdx) => {
      db.run(`INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price, cost, line_total, sort_order, mock)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [iid, li.description, li.quantity, li.unit, li.unit_price, li.cost, li.line_total, lIdx]);
    });

    // Post JEs for sent+ invoices
    // Reconstruct invoice object for posting
    const invObj = db.get('SELECT * FROM invoices WHERE id = ?', [iid]);
    invObj.display_number = `INV-${db.get('SELECT display_number FROM work_orders WHERE id = ?', [est.work_order_id]).display_number}`;

    if (['sent','paid','overdue'].includes(invStatus)) {
      try { posting.postInvoiceSent(invObj, { userId: 1 }); } catch(e) { console.warn('  JE post (invoice sent) failed:', e.message); }
    }
    if (invStatus === 'paid' && amountPaid > 0) {
      try { posting.postPaymentReceived(invObj, amountPaid, { userId: 1 }); } catch(e) { console.warn('  JE post (payment) failed:', e.message); }
    }
    if (invStatus === 'void') {
      try { posting.postInvoiceVoid(invObj, { userId: 1 }); } catch(e) { console.warn('  JE post (void) failed:', e.message); }
    }
  });

  // ── 10. Vendor Bills (12) ──
  let billCount = 0;
  const BILL_STATUSES = ['draft','draft','draft','approved','approved','approved','approved','paid','paid','paid','paid','void'];
  const BILL_TOTALS = [1200,3500,875,2400,1800,4500,3200,5600,2100,3900,4800,950];
  const BILL_TAXES = [0,0,0,120,90,225,160,280,105,195,240,0];

  for (let idx = 0; idx < 12; idx++) {
    const vendorId = vendIds[idx % vendIds.length];
    const bstatus = BILL_STATUSES[idx];
    const total = Math.round(rngDec(500, 6000) * 100) / 100;
    const tax = Math.round(total * (Math.random() > 0.5 ? 0 : 0.0625) * 100) / 100;
    const subtotal = Math.round((total - tax) * 100) / 100;

    const existing = db.get('SELECT id FROM bills WHERE vendor_id = ? AND bill_number = ? AND mock = 1', [vendorId, `MOCK-BILL-${1000+idx}`]);
    if (existing) continue;

    const r = db.run(`INSERT INTO bills
      (vendor_id, bill_number, status, bill_date, due_date, subtotal, tax_amount, total, notes, source, created_by_user_id, mock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, 1, ?, ?)`,
      [vendorId, `MOCK-BILL-${1000+idx}`, bstatus, future(-rng(5,20)), future(rng(5,25)),
       subtotal, tax, total, null, ago(rng(3,20)), ago(rng(1,10))]);
    const bid = r.lastInsertRowid;
    billCount++;

    // Add 1-3 line items that sum to subtotal
    const numLines = rng(1, 3);
    let remaining = subtotal;
    for (let li = 0; li < numLines; li++) {
      const isLast = li === numLines - 1;
      const maxThisLine = isLast ? remaining : Math.min(remaining * 0.7, remaining - (numLines - li - 1) * 50);
      const minThisLine = Math.round(Math.min(remaining * 0.1, maxThisLine) * 100) / 100;
      const lt = isLast ? Math.round(remaining * 100) / 100 : Math.round(rngDec(minThisLine, maxThisLine) * 100) / 100;
      remaining = Math.round((remaining - lt) * 100) / 100;
      const acctId = db.get("SELECT id FROM accounts WHERE code='5900' AND active=1").id;
      db.run(`INSERT INTO bill_lines (bill_id, account_id, description, quantity, unit_price, line_total, sort_order, mock)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [bid, acctId, `Mock supply item ${idx}-${li}`, 1, lt, lt, li]);
    }

    // Post JEs for approved+ bills
    if (['approved','paid'].includes(bstatus)) {
      const bill = db.get('SELECT * FROM bills WHERE id = ?', [bid]);
      const lines = db.all('SELECT * FROM bill_lines WHERE bill_id = ?', [bid]);
      try { posting.postBillApproved(bill, lines, { userId: 1 }); } catch(e) { console.warn('  JE post (bill approve) failed:', e.message); }
    }
    if (bstatus === 'paid') {
      const bill = db.get('SELECT * FROM bills WHERE id = ?', [bid]);
      try { posting.postBillPaid(bill, total, { userId: 1 }); } catch(e) { console.warn('  JE post (bill pay) failed:', e.message); }
    }
  }

  // ── Results ──
  console.log(`\n  Seeding complete. Counts:`);
  console.log(`    Items library:  ${itemsInserted} inserted (${allItems.length} total)`);
  console.log(`    Users:          ${userCount} added (${allUsers.length} active)`);
  console.log(`    Customers:      ${custCount}`);
  console.log(`    Vendors:        ${vendCount}`);
  console.log(`    Jobs:           ${jobCount}`);
  console.log(`    Work Orders:    ${woCount}`);
  console.log(`    Estimates:      ${estCount}`);
  console.log(`    Invoices:       ${invCount}`);
  console.log(`    Bills:          ${billCount}`);

  // Check trial balance
  const accts = db.all(`SELECT a.code, a.name, a.type,
    COALESCE(SUM(jl.debit),0) as tot_dr, COALESCE(SUM(jl.credit),0) as tot_cr
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
    GROUP BY a.id`);

  let totalDr=0, totalCr=0;
  accts.forEach(a => { totalDr+=a.tot_dr; totalCr+=a.tot_cr; });
  console.log(`  Trial Balance: Dr $${totalDr.toFixed(2)} = Cr $${totalCr.toFixed(2)}${Math.abs(totalDr-totalCr)<0.01 ? ' ✅' : ' ❌'}`);
  console.log(`  Journal entries: ${db.get('SELECT COUNT(*) AS n FROM journal_entries').n}`);
  console.log('');

  // ── Seed root folders + sample files ──
  try {
    const filesSvc = require('../services/files');
    const path = require('path');
    const fs = require('fs');

    // Create root folders for all existing entities
    const allCustomers = db.all('SELECT id FROM customers');
    allCustomers.forEach(c => filesSvc.ensureRootFolder('customer', c.id, null));
    const allVendors = db.all('SELECT id FROM vendors');
    allVendors.forEach(v => filesSvc.ensureRootFolder('vendor', v.id, null));
    const allUsers = db.all('SELECT id FROM users');
    allUsers.forEach(u => filesSvc.ensureRootFolder('user', u.id, null));
    const allWOs = db.all('SELECT id FROM work_orders');
    allWOs.forEach(wo => filesSvc.ensureRootFolder('work_order', wo.id, null));

    // Generate sample placeholder files (synchronous, simple text)
    function createSampleFile(entityType, entityId, docType) {
      const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'files', entityType, String(entityId));
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const filename = require('crypto').randomUUID() + '-' + docType.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.txt';
      const filepath = path.join(uploadDir, filename);
      const content = 'Sample - ' + docType + '\n========================\n\nThis is a placeholder document generated by the FORGE seed system.\nType: ' + docType + '\nEntity: ' + entityType + ' #' + entityId + '\nGenerated: ' + new Date().toISOString();
      fs.writeFileSync(filepath, content, 'utf8');
      const folder = filesSvc.getRootFolder(entityType, entityId);
      if (folder) {
        db.run('INSERT INTO files (folder_id, name, original_filename, storage_path, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
          [folder.id, filename, docType + '.txt', filepath, 'text/plain', fs.statSync(filepath).size]);
      }
    }

    // Per vendor: 1 COI
    allVendors.forEach(v => createSampleFile('vendor', v.id, 'COI'));
    // Per worker: 1 W9 + 1 safety cert
    const workers = db.all("SELECT id FROM users WHERE role = 'worker'");
    workers.forEach(w => {
      createSampleFile('user', w.id, 'W9');
      createSampleFile('user', w.id, 'Safety Cert');
    });
    // Top 5 customers: 1 contract
    const topCustomers = db.all('SELECT id FROM customers ORDER BY id ASC LIMIT 5');
    topCustomers.forEach(c => createSampleFile('customer', c.id, 'Contract'));
    // 3 WOs: 1 permit
    const someWOs = db.all('SELECT id FROM work_orders ORDER BY id ASC LIMIT 3');
    someWOs.forEach(wo => createSampleFile('work_order', wo.id, 'Permit'));

    console.log('  Seeded root folders + sample files for all entities.');
  } catch(e) { console.error('  Folder/PDF seeding failed:', e.message); }
}

// ── Main ──
(async () => {
  try {
    await db.init();
    await seedMock();
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
  db.persist();
  // Give persistence time
  setTimeout(() => process.exit(0), 200);
})();
