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
  db.persist();
  console.log('DB initialized at', path.join(__dirname, '..', '..', 'data', 'app.db'));
  process.exit(0);
}

main().catch(err => {
  console.error('init failed:', err);
  process.exit(1);
});
