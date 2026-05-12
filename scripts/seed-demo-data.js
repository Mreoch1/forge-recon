/**
 * D-028: Seed minimal demo data for beta walkthrough.
 * Idempotent — checks for existing "DEMO" rows before inserting.
 * Run: node scripts/seed-demo-data.js
 */
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Seed failed: DATABASE_URL_DIRECT or DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 1,
});

async function seed() {
  // Check if demo data already exists
  const { rows: existing } = await pool.query("SELECT id FROM customers WHERE name LIKE '%(DEMO)%' LIMIT 1");
  if (existing.length > 0) {
    console.log('Demo data already exists — skipping. IDs:', existing[0].id);
    await pool.end();
    return;
  }

  // Get user IDs for Eric and Chris
  const { rows: users } = await pool.query("SELECT id, name, email FROM users WHERE email IN ('eric@reconenterprises.net','chris@reconenterprises.net','office@reconenterprises.net','mike@reconenterprises.net')");
  const userMap = {};
  users.forEach(u => { userMap[u.email.split('@')[0]] = u.id; });
  console.log('Users:', userMap);

  // 1. Create 2 customers
  const { rows: c1 } = await pool.query(
    "INSERT INTO customers (name, email, phone, address, city, state, zip, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    ['Sample Customer A (DEMO)', 'demo+a@example.com', '(555) 111-0001', '100 Demo Blvd', 'Demo City', 'MI', '48001', 'Demo customer for beta testing']
  );
  const { rows: c2 } = await pool.query(
    "INSERT INTO customers (name, email, phone, address, city, state, zip, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    ['Sample Customer B (DEMO)', 'demo+b@example.com', '(555) 111-0002', '200 Test Ave', 'Testville', 'MI', '48002', 'Beta test customer B']
  );
  console.log('Customers:', c1[0].id, c2[0].id);

  // 2. Create 1 project per customer
  const { rows: j1 } = await pool.query(
    "INSERT INTO jobs (title, customer_id, address, city, state, zip, contract_value, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    ['Demo Renovation - Building A', c1[0].id, '100 Demo Blvd', 'Demo City', 'MI', '48001', 50000, 'active']
  );
  const { rows: j2 } = await pool.query(
    "INSERT INTO jobs (title, customer_id, address, city, state, zip, contract_value, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    ['Demo Renovation - Building B', c2[0].id, '200 Test Ave', 'Testville', 'MI', '48002', 75000, 'active']
  );
  console.log('Jobs:', j1[0].id, j2[0].id);

  // 3. Create 2 WOs per project
  const { rows: wo1 } = await pool.query(
    "INSERT INTO work_orders (job_id, customer_id, display_number, wo_number_main, description, status, scheduled_date, unit_number, assigned_to_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [j1[0].id, c1[0].id, 'WO-DEMO-001', 9991, 'Demo work order - exterior painting', 'scheduled', '2026-05-19', 'A101', userMap['eric']]
  );
  const { rows: wo2 } = await pool.query(
    "INSERT INTO work_orders (job_id, customer_id, display_number, wo_number_main, description, status, scheduled_date, unit_number, assigned_to_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [j1[0].id, c1[0].id, 'WO-DEMO-002', 9992, 'Demo work order - interior finishing', 'in_progress', '2026-05-15', 'A102', userMap['chris']]
  );
  const { rows: wo3 } = await pool.query(
    "INSERT INTO work_orders (job_id, customer_id, display_number, wo_number_main, description, status, scheduled_date, unit_number, assigned_to_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [j2[0].id, c2[0].id, 'WO-DEMO-003', 9993, 'Demo work order B - roof repair', 'scheduled', '2026-05-22', 'B201', userMap['eric']]
  );
  const { rows: wo4 } = await pool.query(
    "INSERT INTO work_orders (job_id, customer_id, display_number, wo_number_main, description, status, scheduled_date, unit_number, assigned_to_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [j2[0].id, c2[0].id, 'WO-DEMO-004', 9994, 'Demo work order B - electrical', 'in_progress', '2026-05-16', 'B202', userMap['chris']]
  );
  console.log('WOs:', wo1[0].id, wo2[0].id, wo3[0].id, wo4[0].id);

  // Add work_order_assignees
  for (const wo of [wo1[0].id, wo2[0].id, wo3[0].id, wo4[0].id]) {
    await pool.query("INSERT INTO work_order_assignees (work_order_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [wo, userMap['eric']]);
    await pool.query("INSERT INTO work_order_assignees (work_order_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [wo, userMap['chris']]);
  }

  // 4. Create 1 estimate per project (2 line items each)
  const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + 30);
  const { rows: e1 } = await pool.query(
    "INSERT INTO estimates (work_order_id, status, valid_until, tax_rate) VALUES ($1,$2,$3,$4) RETURNING id",
    [wo1[0].id, 'draft', dueDate.toISOString().slice(0,10), 6]
  );
  const { rows: e2 } = await pool.query(
    "INSERT INTO estimates (work_order_id, status, valid_until, tax_rate) VALUES ($1,$2,$3,$4) RETURNING id",
    [wo3[0].id, 'draft', dueDate.toISOString().slice(0,10), 6]
  );

  // Estimate line items
  await pool.query("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, cost) VALUES ($1,$2,$3,$4,$5)", [e1[0].id, 'Interior paint - labor', 40, 65, 1200]);
  await pool.query("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, cost) VALUES ($1,$2,$3,$4,$5)", [e1[0].id, 'Paint materials - premium', 10, 45, 350]);
  await pool.query("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, cost) VALUES ($1,$2,$3,$4,$5)", [e2[0].id, 'Roof shingles - architectural', 30, 120, 2400]);
  await pool.query("INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, cost) VALUES ($1,$2,$3,$4,$5)", [e2[0].id, 'Labor - roofing crew', 24, 55, 1050]);
  console.log('Estimates:', e1[0].id, e2[0].id);

  // 5. Create 1 invoice per project (sent, due next week)
  const dueWeek = new Date(); dueWeek.setDate(dueWeek.getDate() + 7);
  const { rows: inv1 } = await pool.query(
    "INSERT INTO invoices (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, amount_paid, due_date, payment_terms, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [e1[0].id, wo1[0].id, 'sent', 2600, 6, 156, 2756, 0, dueWeek.toISOString().slice(0,10), 'Net 30', new Date()]
  );
  const { rows: inv2 } = await pool.query(
    "INSERT INTO invoices (estimate_id, work_order_id, status, subtotal, tax_rate, tax_amount, total, amount_paid, due_date, payment_terms, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [e2[0].id, wo3[0].id, 'sent', 3450, 6, 207, 3657, 0, dueWeek.toISOString().slice(0,10), 'Net 30', new Date()]
  );
  console.log('Invoices:', inv1[0].id, inv2[0].id);

  // 6. Create 1 vendor + 1 vendor_invoice per project
  const { rows: v1 } = await pool.query("INSERT INTO vendors (name, email, phone, mock) VALUES ($1,$2,$3,$4) RETURNING id",
    ['Demo Paint Supply Co.', 'orders@demopaint.example.com', '(555) 999-0101', 0]);
  const { rows: v2 } = await pool.query("INSERT INTO vendors (name, email, phone, mock) VALUES ($1,$2,$3,$4) RETURNING id",
    ['Demo Roofing Supply Inc.', 'orders@demoroof.example.com', '(555) 999-0102', 0]);

  // Link to projects
  await pool.query("INSERT INTO project_contractors (job_id, vendor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [j1[0].id, v1[0].id]);
  await pool.query("INSERT INTO project_contractors (job_id, vendor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [j2[0].id, v2[0].id]);

  await pool.query("INSERT INTO vendor_invoices (job_id, vendor_id, description, amount, invoice_number) VALUES ($1,$2,$3,$4,$5)", [j1[0].id, v1[0].id, 'Paint order - Building A', 1850, 'INV-PAINT-001']);
  await pool.query("INSERT INTO vendor_invoices (job_id, vendor_id, description, amount, invoice_number) VALUES ($1,$2,$3,$4,$5)", [j2[0].id, v2[0].id, 'Roofing materials - Building B', 3200, 'INV-ROOF-001']);
  console.log('Vendors:', v1[0].id, v2[0].id);

  console.log('\n=== SEED COMPLETE ===');
  console.log('Customers:', c1[0].id, c2[0].id);
  console.log('Projects:', j1[0].id, j2[0].id);
  console.log('WOs:', wo1[0].id, wo2[0].id, wo3[0].id, wo4[0].id);
  console.log('Estimates:', e1[0].id, e2[0].id);
  console.log('Invoices:', inv1[0].id, inv2[0].id);
  console.log('Vendors:', v1[0].id, v2[0].id);

  await pool.end();
}

seed().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
