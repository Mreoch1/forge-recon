/**
 * One-shot script to delete demo WOs and their linked estimates/invoices.
 * Run via: node scripts/delete-demo-wo.js
 * Requires DATABASE_URL_DIRECT or DATABASE_URL env var.
 * 
 * Created 2026-05-20 per Michael's request.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { Pool } = require('pg');

async function main() {
  // Try DATABASE_URL_DIRECT first, then DATABASE_URL, then construct from parts
  let connStr = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  
  if (!connStr) {
    // Construct from POSTGRES_* parts (Vercel style)
    const pgHost = process.env.POSTGRES_HOST;
    const pgUser = process.env.POSTGRES_USER;
    const pgPass = process.env.POSTGRES_PASSWORD;
    const pgDb   = process.env.POSTGRES_DATABASE;
    const pgSsl  = process.env.PGSSLMODE || 'require';
    if (pgHost && pgUser && pgPass && pgDb) {
      connStr = `postgres://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPass)}@${pgHost}:5432/${encodeURIComponent(pgDb)}?sslmode=${pgSsl}`;
    }
  }

  if (!connStr) {
    console.error('No database connection string found. Set DATABASE_URL_DIRECT, DATABASE_URL, or POSTGRES_* env vars.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: connStr, max: 1 });

  const displayNumbers = ['WO-DEMO-003', 'WO-DEMO-002', 'WO-DEMO-001'];

  try {
    // Find WOs
    const { rows: wos } = await pool.query(
      'SELECT id, display_number FROM work_orders WHERE display_number = ANY($1)',
      [displayNumbers]
    );
    console.log(`Found ${wos.length} work orders to delete:`, wos.map(w => w.display_number).join(', '));

    for (const wo of wos) {
      const woId = wo.id;
      console.log(`\nProcessing WO ${wo.display_number} (id=${woId})...`);

      // Find linked estimate
      const { rows: estimates } = await pool.query(
        'SELECT id, display_number FROM estimates WHERE work_order_id = $1',
        [woId]
      );

      for (const est of estimates) {
        console.log(`  Found estimate ${est.display_number} (id=${est.id})`);

        // Find linked invoice
        const { rows: invoices } = await pool.query(
          'SELECT id, display_number FROM invoices WHERE estimate_id = $1',
          [est.id]
        );

        for (const inv of invoices) {
          console.log(`    Found invoice ${inv.display_number} (id=${inv.id})`);
          
          // Delete invoice_line_items
          const r1 = await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [inv.id]);
          console.log(`    Deleted ${r1.rowCount} invoice line items`);
          
          // Delete invoice
          const r2 = await pool.query('DELETE FROM invoices WHERE id = $1', [inv.id]);
          console.log(`    Deleted invoice`);
        }

        // Delete estimate_line_items
        const r3 = await pool.query('DELETE FROM estimate_line_items WHERE estimate_id = $1', [est.id]);
        console.log(`  Deleted ${r3.rowCount} estimate line items`);

        // Delete estimate
        const r4 = await pool.query('DELETE FROM estimates WHERE id = $1', [est.id]);
        console.log(`  Deleted estimate`);
      }

      // Delete work_order_assignees
      await pool.query('DELETE FROM work_order_assignees WHERE work_order_id = $1', [woId]);
      
      // Delete work_order_line_items
      await pool.query('DELETE FROM work_order_line_items WHERE work_order_id = $1', [woId]);
      
      // Delete wo_notes
      await pool.query('DELETE FROM wo_notes WHERE work_order_id = $1', [woId]);
      
      // Delete wo_photos
      await pool.query('DELETE FROM wo_photos WHERE work_order_id = $1', [woId]);

      // Delete work_order itself
      const r5 = await pool.query('DELETE FROM work_orders WHERE id = $1', [woId]);
      console.log(`  Deleted WO (${r5.rowCount} rows)`);
    }

    console.log('\nDone!');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
