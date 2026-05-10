/**
 * Dashboard route. Mounted at GET /.
 *
 * Round 13: the modern operational dashboard (today-focused schedule, action queue,
 * activity stream) is the default at "/". The earlier KPI-card dashboard has been
 * moved to "/dashboard-classic" for reference and easy revert.
 */

const express = require('express');
const db = require('../db/db');

const router = express.Router();

// Classic dashboard handler (was the original "/")
router.get('/dashboard-classic', (req, res) => {
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

// =============================================================================
// "/" — the modern operational dashboard (today-focused schedule list,
// asymmetric action queues, denser typography, flat right-rail action queue).
// The earlier KPI-card dashboard is at /dashboard-classic.
// =============================================================================
router.get('/', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ---------- Schedule: today (the primary anchor) ----------
  // Pull every WO scheduled for today (any status that's still "live"),
  // joined to customer + assignee. Sort by time, then by WO number.
  const todayWOs = db.all(`
    SELECT w.id, w.display_number, w.scheduled_time, w.status, w.assigned_to,
           j.id AS job_id, j.title AS job_title,
           j.address AS job_address, j.city AS job_city,
           c.id AS customer_id, c.name AS customer_name,
           u.id AS user_id, u.name AS user_name
    FROM work_orders w
    JOIN jobs j        ON j.id = w.job_id
    JOIN customers c   ON c.id = j.customer_id
    LEFT JOIN users u  ON u.id = w.assigned_to_user_id
    WHERE w.scheduled_date = ?
      AND w.status IN ('scheduled','in_progress')
    ORDER BY COALESCE(w.scheduled_time, '99:99'), w.display_number
  `, [today]);

  // ---------- Schedule: tomorrow preview (count + first 3) ----------
  const tomorrowWOs = db.all(`
    SELECT w.id, w.display_number, w.scheduled_time,
           j.title AS job_title,
           c.name AS customer_name,
           u.name AS user_name, w.assigned_to
    FROM work_orders w
    JOIN jobs j        ON j.id = w.job_id
    JOIN customers c   ON c.id = j.customer_id
    LEFT JOIN users u  ON u.id = w.assigned_to_user_id
    WHERE w.scheduled_date = ?
      AND w.status IN ('scheduled','in_progress')
    ORDER BY COALESCE(w.scheduled_time, '99:99')
  `, [tomorrow]);

  const tomorrowCount = tomorrowWOs.length;
  const tomorrowPreview = tomorrowWOs.slice(0, 3);

  // ---------- Schedule: this week (peek) ----------
  const upcomingThisWeek = (db.get(`
    SELECT COUNT(*) AS n FROM work_orders
    WHERE date(scheduled_date) BETWEEN date(?, '+2 days') AND date(?, '+7 days')
      AND status IN ('scheduled','in_progress')
  `, [today, today]) || {}).n || 0;

  // ---------- Action queues ----------
  // Each queue: count, optional total dollar amount, click-through URL, urgency level.

  // 1. Estimates ready to send (draft)
  const estimatesToSend = db.all(`
    SELECT e.id, w.display_number, e.total, c.name AS customer_name, e.created_at
    FROM estimates e
    JOIN work_orders w ON w.id = e.work_order_id
    JOIN jobs j        ON j.id = w.job_id
    JOIN customers c   ON c.id = j.customer_id
    WHERE e.status = 'draft'
    ORDER BY e.created_at DESC
    LIMIT 5
  `);
  const estimatesToSendCount = (db.get(
    "SELECT COUNT(*) AS n FROM estimates WHERE status='draft'"
  ) || {}).n || 0;

  // 2. Invoices overdue (sent + past due_date)
  const overdueInvoices = db.all(`
    SELECT i.id, w.display_number, i.total, i.amount_paid, i.due_date,
           c.name AS customer_name,
           CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_late
    FROM invoices i
    JOIN work_orders w ON w.id = i.work_order_id
    JOIN jobs j        ON j.id = w.job_id
    JOIN customers c   ON c.id = j.customer_id
    WHERE i.status IN ('sent','overdue')
      AND i.due_date IS NOT NULL
      AND date(i.due_date) < date('now')
    ORDER BY i.due_date ASC
    LIMIT 5
  `);
  const overdueInvoicesCount = (db.get(`
    SELECT COUNT(*) AS n FROM invoices
    WHERE status IN ('sent','overdue')
      AND due_date IS NOT NULL
      AND date(due_date) < date('now')
  `) || {}).n || 0;
  const overdueTotal = Number((db.get(`
    SELECT COALESCE(SUM(total - amount_paid), 0) AS n FROM invoices
    WHERE status IN ('sent','overdue')
      AND due_date IS NOT NULL
      AND date(due_date) < date('now')
  `) || {}).n) || 0;

  // 3. Bills awaiting approval (draft)
  let billsToApproveCount = 0;
  let billsToApproveTotal = 0;
  let billsToApprove = [];
  try {
    billsToApproveCount = (db.get(
      "SELECT COUNT(*) AS n FROM bills WHERE status='draft'"
    ) || {}).n || 0;
    billsToApproveTotal = Number((db.get(
      "SELECT COALESCE(SUM(total), 0) AS n FROM bills WHERE status='draft'"
    ) || {}).n) || 0;
    billsToApprove = db.all(`
      SELECT b.id, b.bill_number, b.total, b.due_date, v.name AS vendor_name
      FROM bills b
      JOIN vendors v ON v.id = b.vendor_id
      WHERE b.status='draft'
      ORDER BY b.created_at DESC
      LIMIT 5
    `);
  } catch (e) {
    // bills table may not exist on older DBs — soft-fail
  }

  // 4. Estimates stale (sent > 7 days ago, no acceptance)
  const staleEstimates = db.all(`
    SELECT e.id, w.display_number, e.total, c.name AS customer_name,
           e.sent_at,
           CAST(julianday('now') - julianday(e.sent_at) AS INTEGER) AS days_since_sent
    FROM estimates e
    JOIN work_orders w ON w.id = e.work_order_id
    JOIN jobs j        ON j.id = w.job_id
    JOIN customers c   ON c.id = j.customer_id
    WHERE e.status='sent'
      AND e.sent_at IS NOT NULL
      AND date(e.sent_at) < date('now', '-7 days')
    ORDER BY e.sent_at ASC
    LIMIT 5
  `);
  const staleEstimatesCount = staleEstimates.length;

  // ---------- Activity stream ----------
  const activity = db.all(`
    SELECT * FROM (
      SELECT 'work_order' AS type, w.id AS id, ('WO-' || w.display_number) AS number,
             w.status AS status, w.created_at AS created_at, NULL AS total,
             j.title AS job_title, c.name AS customer_name
      FROM work_orders w
      JOIN jobs j      ON j.id = w.job_id
      JOIN customers c ON c.id = j.customer_id
      UNION ALL
      SELECT 'estimate', e.id, ('EST-' || w.display_number),
             e.status, e.created_at, e.total,
             j.title, c.name
      FROM estimates e
      JOIN work_orders w ON w.id = e.work_order_id
      JOIN jobs j        ON j.id = w.job_id
      JOIN customers c   ON c.id = j.customer_id
      UNION ALL
      SELECT 'invoice', i.id, ('INV-' || w.display_number),
             i.status, i.created_at, i.total,
             j.title, c.name
      FROM invoices i
      JOIN work_orders w ON w.id = i.work_order_id
      JOIN jobs j        ON j.id = w.job_id
      JOIN customers c   ON c.id = j.customer_id
    )
    ORDER BY created_at DESC
    LIMIT 12
  `);

  // ---------- Bottom metrics (de-emphasized but present) ----------
  const arBalance = Number((db.get(
    "SELECT COALESCE(SUM(total - amount_paid), 0) AS n FROM invoices WHERE status IN ('sent','overdue')"
  ) || {}).n) || 0;
  const revenueThisMonth = Number((db.get(
    "SELECT COALESCE(SUM(amount_paid), 0) AS n FROM invoices " +
    "WHERE status='paid' AND paid_at IS NOT NULL " +
    "AND strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now')"
  ) || {}).n) || 0;
  const revenueYTD = Number((db.get(
    "SELECT COALESCE(SUM(amount_paid), 0) AS n FROM invoices " +
    "WHERE status='paid' AND paid_at IS NOT NULL " +
    "AND strftime('%Y', paid_at) = strftime('%Y', 'now')"
  ) || {}).n) || 0;
  const customerCount = (db.get('SELECT COUNT(*) AS n FROM customers') || {}).n || 0;
  const jobsActive = (db.get(
    "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('estimating','scheduled','in_progress')"
  ) || {}).n || 0;

  res.render('dashboard/v2', {
    title: 'Dashboard',
    activeNav: 'dashboard',
    today, tomorrow,
    todayWOs, tomorrowPreview, tomorrowCount, upcomingThisWeek,
    estimatesToSend, estimatesToSendCount,
    overdueInvoices, overdueInvoicesCount, overdueTotal,
    billsToApprove, billsToApproveCount, billsToApproveTotal,
    staleEstimates, staleEstimatesCount,
    activity,
    arBalance, revenueThisMonth, revenueYTD, customerCount, jobsActive,
    serverTime: new Date().toISOString(),
  });
});

module.exports = router;
