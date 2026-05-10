/**
 * Dashboard route. Mounted at GET /.
 *
 * Pulls a live KPI snapshot + a unified activity feed of the latest 10
 * estimate/WO/invoice events.
 */

const express = require('express');
const db = require('../db/db');

const router = express.Router();

router.get('/', (req, res) => {
  const openEstimates = (db.get(
    "SELECT COUNT(*) AS n FROM estimates WHERE status IN ('draft','sent')"
  ) || {}).n || 0;

  const scheduledWOs = (db.get(
    "SELECT COUNT(*) AS n FROM work_orders WHERE status IN ('scheduled','in_progress')"
  ) || {}).n || 0;

  const unpaidInvoices = (db.get(
    "SELECT COUNT(*) AS n FROM invoices WHERE status IN ('sent','overdue')"
  ) || {}).n || 0;

  const arBalance = Number((db.get(
    "SELECT COALESCE(SUM(total - amount_paid), 0) AS n FROM invoices WHERE status IN ('sent','overdue')"
  ) || {}).n) || 0;

  // Revenue this month (sum of paid invoices where paid_at falls in current month)
  // Using SQLite date functions: strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now')
  const revenueThisMonth = Number((db.get(
    "SELECT COALESCE(SUM(amount_paid), 0) AS n FROM invoices " +
    "WHERE status='paid' AND paid_at IS NOT NULL " +
    "AND strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now')"
  ) || {}).n) || 0;

  // Revenue YTD
  const revenueYTD = Number((db.get(
    "SELECT COALESCE(SUM(amount_paid), 0) AS n FROM invoices " +
    "WHERE status='paid' AND paid_at IS NOT NULL " +
    "AND strftime('%Y', paid_at) = strftime('%Y', 'now')"
  ) || {}).n) || 0;

  // Overdue count (sent past due_date)
  const overdueCount = (db.get(
    "SELECT COUNT(*) AS n FROM invoices " +
    "WHERE status='sent' AND due_date IS NOT NULL AND date(due_date) < date('now')"
  ) || {}).n || 0;

  const overdueBalance = Number((db.get(
    "SELECT COALESCE(SUM(total - amount_paid), 0) AS n FROM invoices " +
    "WHERE status='sent' AND due_date IS NOT NULL AND date(due_date) < date('now')"
  ) || {}).n) || 0;

  // Unified recent activity (latest 10 across estimates/WOs/invoices).
  // v0.5: estimate -> work_orders -> jobs (no direct estimates.job_id).
  // Display number for all three is the WO display_number prefixed.
  const activity = db.all(`
    SELECT * FROM (
      SELECT 'work_order' AS type, w.id AS id, ('WO-' || w.display_number) AS number,
             w.status AS status, w.created_at AS created_at, NULL AS total,
             j.id AS job_id, j.title AS job_title,
             c.id AS customer_id, c.name AS customer_name
      FROM work_orders w
      JOIN jobs j      ON j.id = w.job_id
      JOIN customers c ON c.id = j.customer_id
      UNION ALL
      SELECT 'estimate' AS type, e.id, ('EST-' || w.display_number),
             e.status, e.created_at, e.total,
             j.id, j.title, c.id, c.name
      FROM estimates e
      JOIN work_orders w ON w.id = e.work_order_id
      JOIN jobs j        ON j.id = w.job_id
      JOIN customers c   ON c.id = j.customer_id
      UNION ALL
      SELECT 'invoice' AS type, i.id, ('INV-' || w.display_number),
             i.status, i.created_at, i.total,
             j.id, j.title, c.id, c.name
      FROM invoices i
      JOIN work_orders w ON w.id = i.work_order_id
      JOIN jobs j        ON j.id = w.job_id
      JOIN customers c   ON c.id = j.customer_id
    )
    ORDER BY created_at DESC
    LIMIT 10
  `);

  // Customer + job counts (for "growth" indicators / context)
  const customerCount = (db.get('SELECT COUNT(*) AS n FROM customers') || {}).n || 0;
  const jobCount = (db.get('SELECT COUNT(*) AS n FROM jobs') || {}).n || 0;

  res.render('dashboard/index', {
    title: 'Dashboard',
    activeNav: 'dashboard',
    openEstimates, scheduledWOs, unpaidInvoices, arBalance,
    revenueThisMonth, revenueYTD,
    overdueCount, overdueBalance,
    activity, customerCount, jobCount,
  });
});

module.exports = router;
