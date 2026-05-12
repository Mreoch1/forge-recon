/**
 * schema-check.js — Verify required tables + columns via PostgREST introspection.
 * Run: node scripts/schema-check.js
 * Exit: 0 = pass, 1 = fail
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Each entry: { table, columns: [col1, col2, ...] }
// We try to select them — if a column is missing PostgREST returns an error.
const CHECKS = [
  { table: 'work_orders',     columns: ['id', 'customer_id', 'unit_number', 'display_number'] },
  { table: 'customers',        columns: ['id', 'name', 'email'] },
  { table: 'folders',          columns: ['id', 'entity_type', 'entity_id', 'is_root'] },
  { table: 'files',            columns: ['id', 'folder_id', 'storage_path'] },
  { table: 'estimates',        columns: ['id', 'status', 'sent_by_user_id'] },
  { table: 'invoices',         columns: ['id', 'status', 'sent_by_user_id'] },
  { table: 'work_order_assignees', columns: ['work_order_id', 'user_id'] },
];

async function main() {
  let passed = 0, failed = 0;

  for (const { table, columns } of CHECKS) {
    const colStr = columns.join(',');
    const { error } = await supabase.from(table).select(colStr).limit(1);
    if (error) {
      console.log(`❌ ${table} (${columns.join(', ')}) — ${error.message}`);
      failed++;
    } else {
      console.log(`✅ ${table} — columns OK (${columns.join(', ')})`);
      passed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
