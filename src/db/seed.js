/**
 * Seed initial data:
 *   - Admin user (admin@recon.local / changeme123) — must be rotated
 *   - Singleton company_settings row
 *
 *   npm run seed
 *
 * Idempotent — re-running won't duplicate.
 */

const bcrypt = require('bcrypt');
const db = require('./db');

async function main() {
  await db.init();

  const existingAdmin = db.get('SELECT id FROM users WHERE email = ?', ['admin@recon.local']);
  if (!existingAdmin) {
    const hash = await bcrypt.hash('changeme123', 10);
    db.run(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      ['admin@recon.local', hash, 'Admin', 'admin']
    );
    console.log('Seeded admin user: admin@recon.local / changeme123  (ROTATE)');
  } else {
    console.log('Admin user already exists — skipping.');
  }

  const existingCo = db.get('SELECT id FROM company_settings WHERE id = 1');
  if (!existingCo) {
    db.run(
      `INSERT INTO company_settings (id, company_name, current_year)
       VALUES (1, ?, ?)`,
      ['Recon Construction', new Date().getFullYear()]
    );
    console.log('Seeded company_settings row.');
  } else {
    console.log('company_settings already initialized — skipping.');
  }

  db.persist();
  console.log('Seed complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('seed failed:', err);
  process.exit(1);
});
