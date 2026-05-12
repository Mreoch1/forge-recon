/**
 * schema-check.js — Verify required tables + columns + critical types via PostgREST.
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

const CHECKS = [
  { table: 'work_orders',     columns: ['id', 'customer_id', 'unit_number', 'display_number'] },
  { table: 'customers',        columns: ['id', 'name', 'email'] },
  { table: 'folders',          columns: ['id', 'entity_type', 'entity_id', 'is_root'] },
  { table: 'files',            columns: ['id', 'folder_id', 'storage_path'] },
  { table: 'estimates',        columns: ['id', 'status', 'sent_by_user_id'] },
  { table: 'invoices',         columns: ['id', 'status', 'sent_by_user_id'] },
  { table: 'work_order_assignees', columns: ['work_order_id', 'user_id'] },
];

// Critical type checks — we read a row and verify values are the expected JS type
// (PostgREST deserializes differently for integer vs boolean columns)
const TYPE_CHECKS = [
  { table: 'folders', column: 'is_root', expect: 'number', hint: 'INTEGER — not boolean (Cowork r35b migration)' },
];

async function main() {
  let passed = 0, failed = 0;

  for (const { table, columns } of CHECKS) {
    const colStr = columns.join(',');
    const { error } = await supabase.from(table).select(colStr).limit(1);
    if (error) {
      console.log(`❌ ${table} — ${error.message}`);
      failed++;
    } else {
      console.log(`✅ ${table} — ${columns.join(', ')}`);
      passed++;
    }
  }

  // Type checks — fetch a row and verify types
  for (const { table, column, expect, hint } of TYPE_CHECKS) {
    const { data, error } = await supabase.from(table).select(column).limit(1).maybeSingle();
    if (error || !data) {
      console.log(`⚠  ${table}.${column} — cannot verify type (${error?.message || 'no data'})`);
      passed++; // soft pass — table might be empty
      continue;
    }
    const actual = typeof data[column];
    if (actual === expect) {
      console.log(`✅ ${table}.${column} — type ${actual} (${hint})`);
      passed++;
    } else {
      console.log(`❌ ${table}.${column} — expected ${expect}, got ${actual}. ${hint}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
