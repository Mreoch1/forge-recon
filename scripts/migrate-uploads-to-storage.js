/**
 * migrate-uploads-to-storage.js — One-shot migration of existing local
 * upload files to Supabase Storage. Run ONCE with USE_PG=1.
 *
 * Usage: USE_PG=1 node scripts/migrate-uploads-to-storage.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('../src/db/db');
const storage = require('../src/services/storage');

const LOCAL_WO = path.join(__dirname, '..', 'public', 'uploads', 'wo');
const LOCAL_FILES = path.join(__dirname, '..', 'public', 'uploads', 'files');

function lookupMime(p) {
  const ext = path.extname(p).toLowerCase().replace('.', '');
  const map = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', pdf:'application/pdf', txt:'text/plain', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  return map[ext] || 'application/octet-stream';
}

async function migrate(table, keyCol, bucket, localBase) {
  const rows = await db.all(`SELECT id, ${keyCol} FROM ${table} WHERE ${keyCol} IS NOT NULL`);
  let moved = 0, missing = 0, skipped = 0;
  for (const row of rows) {
    const key = row[keyCol];
    if (!key || key.includes('storage/v1/') || !key.match(/^[\w-]+\//)) { skipped++; continue; }
    const localPath = path.join(localBase, path.basename(key));
    if (!fs.existsSync(localPath)) { missing++; continue; }
    try {
      const buf = fs.readFileSync(localPath);
      await storage.uploadBuffer(bucket, key, buf, lookupMime(key));
      moved++;
    } catch(e) {
      console.warn(`Failed ${table} #${row.id} key=${key}: ${e.message}`);
    }
  }
  console.log(`${table}: moved=${moved} missing=${missing} skipped=${skipped}`);
}

(async () => {
  await db.init();
  console.log('Migrating uploads to Supabase Storage...');
  await migrate('wo_photos', 'filename', 'wo-photos', LOCAL_WO);
  await migrate('files', 'filename', 'entity-files', LOCAL_FILES);
  process.exit(0);
})();
