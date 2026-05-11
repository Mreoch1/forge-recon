/**
 * Initialize the database: create file (if absent) and apply schema.
 * Idempotent — schema uses CREATE TABLE IF NOT EXISTS.
 *
 *   npm run init-db
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  await db.init();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Idempotent column migrations for existing databases
  migrateColumn('users', 'phone', 'TEXT');
  migrateColumn('users', 'mock', 'INTEGER NOT NULL DEFAULT 0');
  migrateColumn('work_order_line_items', 'completed_at', 'TEXT');
  migrateColumn('work_orders', 'scheduled_end_time', 'TEXT');
  db.persist();
  console.log('DB initialized at', path.join(__dirname, '..', '..', 'data', 'app.db'));
  process.exit(0);
}

function migrateColumn(table, column, type) {
  const cols = db.all("PRAGMA table_info(" + table + ")");
  if (!cols.find(c => c.name === column)) {
    db.run("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
    console.log(`  Added ${table}.${column}`);
  }
}

main().catch(err => {
  console.error('init failed:', err);
  process.exit(1);
});
