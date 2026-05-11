/**
 * pg-seed-bootstrap.js — Minimal seed for pg mode.
 * Creates admin user + company settings so the app is usable.
 * Full mock data seeding needs the seed-mock.js async conversion.
 */
require('dotenv').config();
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

async function main() {
  await db.init();
  const mode = db.getMode();
  console.log(`Seeding in ${mode} mode...`);

  // Create admin user (password: admin123!)
  const existingAdmin = await db.get('SELECT id FROM users WHERE email = ?', ['admin@recon.com']);
  if (!existingAdmin) {
    const hash = await bcrypt.hash('admin123!', 10);
    await db.run(
      "INSERT INTO users (email, password_hash, name, role, active) VALUES (?, ?, ?, ?, true)",
      ['admin@recon.com', hash, 'Admin User', 'admin']
    );
    console.log('  Created admin user: admin@recon.com / admin123!');
  } else {
    console.log('  Admin user already exists.');
  }

  // Create some worker users for mock data
  const existingWorkers = await db.get('SELECT COUNT(*) AS n FROM users WHERE role = ?', ['worker']);
  if (existingWorkers && existingWorkers.n === 0) {
    const workers = [
      { name: 'Mike Kowalski', email: 'mike@recon.local' },
      { name: 'Carlos Mendez', email: 'carlos@recon.local' },
    ];
    for (const w of workers) {
      const wh = await bcrypt.hash('worker123', 10);
      await db.run(
        "INSERT INTO users (email, password_hash, name, role, active) VALUES (?, ?, ?, 'worker', true)",
        [w.email, wh, w.name]
      );
    }
    console.log('  Created 2 worker users.');
  }

  // Create company settings singleton if missing
  const existingSettings = await db.get('SELECT id FROM company_settings WHERE id = 1');
  if (!existingSettings) {
    await db.run(`INSERT INTO company_settings (id, company_name, default_tax_rate, default_payment_terms, next_wo_main_number, current_year)
      VALUES (1, 'Recon Construction', 6.25, 'Net 30', 1, 2026)`);
    console.log('  Created company settings.');
  }

  console.log('Bootstrap seed complete.');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
}).then(async () => {
  if (db.getMode() === 'sqlite') {
    db.persist();
    setTimeout(() => process.exit(0), 200);
  } else {
    process.exit(0);
  }
});
