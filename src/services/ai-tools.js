/**
 * ai-tools.js — Tool registry for the AI chat assistant (Tier 1+2).
 *
 * Each tool has:
 *   name        — string identifier
 *   description — prompt text explaining what it does
 *   args        — { name: type, ... } schema for LLM
 *   needs_user  — 'read' | 'navigate' | 'write'
 *   handler     — (args, ctx) => result (must be JSON-serializable)
 *
 * Worker scoping: workers only have access to search_work_orders, get_schedule,
 * navigate, and search_customers (filtered to their assigned WOs' customers).
 * Financial tools (estimates, invoices, bills, dashboard_summary) are refused.
 */
const db = require('../db/db');

// ── Worker-allowed tools ─────────────────────────────────────────────
const WORKER_ALLOWED = ['search_work_orders', 'get_schedule', 'navigate', 'search_customers'];

// ── Helpers ──────────────────────────────────────────────────────────
function resolveQuery(query) {
  if (!query || !query.trim()) return null;
  const q = query.trim();
  return `%${q}%`;
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

// ── Tool implementations ─────────────────────────────────────────────

const tools = {};

tools.search_customers = {
  description: 'Search customers by name, email, or phone.',
  args: { query: 'string (required) — partial name, email, or phone' },
  needs_user: 'read',
  handler: ({ query }, ctx) => {
    const like = resolveQuery(query);
    if (!like) return [];
    // Workers: only customers whose jobs have a WO assigned to them
    let cond = '(name LIKE ? OR email LIKE ? OR phone LIKE ?)';
    const params = [like, like, like];
    if (ctx.role === 'worker' && ctx.userId) {
      cond += ' AND c.id IN (SELECT DISTINCT j.customer_id FROM jobs j JOIN work_orders w ON w.job_id = j.id WHERE (w.assigned_to_user_id = ? OR w.assigned_to LIKE ?) AND w.status IN (\'scheduled\',\'in_progress\',\'complete\'))';
      params.push(ctx.userId, `%${ctx.userName}%`);
    }
    const rows = db.all(`SELECT c.id, c.name, c.email, c.phone, c.city, c.state FROM customers c WHERE ${cond} LIMIT 10`, params);
    return rows.map(r => ({ id: r.id, name: r.name, email: r.email || '', phone: r.phone || '', city: r.city || '', state: r.state || '' }));
  }
};

tools.search_estimates = {
  description: 'Search estimates by number, job title, customer name, or filter by status.',
  args: { query: 'string (optional) — partial number, job, or customer name', status: 'string (optional) — draft|sent|accepted|rejected|expired' },
  needs_user: 'read',
  handler: ({ query, status }, ctx) => {
    const conds = ['e.id IS NOT NULL'];
    const params = [];
    if (query) { const like = resolveQuery(query); conds.push('(e.id LIKE ? OR j.title LIKE ? OR c.name LIKE ?)'); params.push(like, like, like); }
    if (status) { conds.push('e.status = ?'); params.push(status); }
    const rows = db.all(`SELECT e.id, e.status, e.total, e.created_at,
      w.display_number AS wo_display,
      j.title AS job_title, c.name AS customer_name
      FROM estimates e
      JOIN work_orders w ON w.id = e.work_order_id
      JOIN jobs j ON j.id = w.job_id
      JOIN customers c ON c.id = j.customer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.created_at DESC LIMIT 10`, params);
    return rows.map(r => ({
      id: r.id, number: `EST-${r.wo_display || ''}`, status: r.status,
      total: Number(r.total) || 0, job_title: r.job_title || '',
      customer_name: r.customer_name || '', days_old: daysAgo(r.created_at)
    }));
  }
};

tools.search_invoices = {
  description: 'Search invoices by number, customer, job, or filter by status. Returns balance info.',
  args: { query: 'string (optional) — partial number, customer, or job', status: 'string (optional) — draft|sent|paid|overdue|void' },
  needs_user: 'read',
  handler: ({ query, status }, ctx) => {
    const conds = ['i.id IS NOT NULL'];
    const params = [];
    if (query) { const like = resolveQuery(query); conds.push('(i.id LIKE ? OR c.name LIKE ? OR j.title LIKE ?)'); params.push(like, like, like); }
    if (status) { conds.push('i.status = ?'); params.push(status); }
    const rows = db.all(`SELECT i.id, i.status, i.total, i.amount_paid, i.due_date, i.created_at,
      w.display_number AS wo_display,
      j.title AS job_title, c.name AS customer_name
      FROM invoices i
      JOIN work_orders w ON w.id = i.work_order_id
      JOIN jobs j ON j.id = w.job_id
      JOIN customers c ON c.id = j.customer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY i.created_at DESC LIMIT 10`, params);
    return rows.map(r => {
      const total = Number(r.total) || 0;
      const paid = Number(r.amount_paid) || 0;
      const bal = Math.round((total - paid) * 100) / 100;
      const due = r.due_date ? String(r.due_date).slice(0,10) : '';
      return {
        id: r.id, number: `INV-${r.wo_display || ''}`, status: r.status,
        total, amount_paid: paid, balance: bal,
        due_date: due, days_late: due ? Math.max(0, daysAgo(due)) : 0,
        customer_name: r.customer_name || '', job_title: r.job_title || ''
      };
    });
  }
};

tools.search_work_orders = {
  description: 'Search work orders by number, customer, job, or filter by status/scheduled_date.',
  args: { query: 'string (optional)', status: 'string (optional)', scheduled_date: 'string (optional)' },
  needs_user: 'read',
  handler: ({ query, status, scheduled_date }, ctx) => {
    const conds = ['w.id IS NOT NULL'];
    const params = [];
    if (query) { const like = resolveQuery(query); conds.push('(w.display_number LIKE ? OR c.name LIKE ? OR j.title LIKE ?)'); params.push(like, like, like); }
    if (status) { conds.push('w.status = ?'); params.push(status); }
    if (scheduled_date) { conds.push('w.scheduled_date = ?'); params.push(scheduled_date); }
    if (ctx.role === 'worker' && ctx.userId) {
      conds.push('(w.assigned_to_user_id = ? OR w.assigned_to LIKE ?)');
      params.push(ctx.userId, `%${ctx.userName}%`);
    }
    const rows = db.all(`SELECT w.id, w.display_number, w.status, w.scheduled_date, w.scheduled_time,
      w.assigned_to, u.name AS assigned_user_name,
      j.title AS job_title, c.name AS customer_name
      FROM work_orders w
      JOIN jobs j ON j.id = w.job_id
      JOIN customers c ON c.id = j.customer_id
      LEFT JOIN users u ON u.id = w.assigned_to_user_id
      WHERE ${conds.join(' AND ')}
      ORDER BY w.scheduled_date ASC, w.scheduled_time ASC LIMIT 10`, params);
    return rows.map(r => ({
      id: r.id, number: `WO-${r.display_number || ''}`, status: r.status,
      scheduled_date: r.scheduled_date ? String(r.scheduled_date).slice(0,10) : '',
      scheduled_time: r.scheduled_time || '',
      customer_name: r.customer_name || '', job_title: r.job_title || '',
      assignee: r.assigned_user_name || r.assigned_to || ''
    }));
  }
};

tools.search_bills = {
  description: 'Search bills by number, vendor name, or filter by status.',
  args: { query: 'string (optional)', status: 'string (optional)', vendor_name: 'string (optional)' },
  needs_user: 'read',
  handler: ({ query, status, vendor_name }, ctx) => {
    const conds = ['b.id IS NOT NULL'];
    const params = [];
    if (query) { const like = resolveQuery(query); conds.push('(b.bill_number LIKE ? OR v.name LIKE ?)'); params.push(like, like); }
    if (status) { conds.push('b.status = ?'); params.push(status); }
    if (vendor_name) { conds.push('v.name LIKE ?'); params.push(`%${vendor_name}%`); }
    const rows = db.all(`SELECT b.id, b.bill_number, b.status, b.total, b.amount_paid, b.bill_date, b.due_date,
      v.name AS vendor_name
      FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id
      WHERE ${conds.join(' AND ')}
      ORDER BY b.created_at DESC LIMIT 10`, params);
    return rows.map(r => ({
      id: r.id, number: r.bill_number || `#${r.id}`, status: r.status,
      total: Number(r.total) || 0, amount_paid: Number(r.amount_paid) || 0,
      vendor_name: r.vendor_name || '', bill_date: r.bill_date || '', due_date: r.due_date || ''
    }));
  }
};

tools.get_schedule = {
  description: 'Get work orders scheduled within a date range, grouped by date.',
  args: { date_start: 'string (required) — YYYY-MM-DD', date_end: 'string (required) — YYYY-MM-DD' },
  needs_user: 'read',
  handler: ({ date_start, date_end }, ctx) => {
    const conds = ['w.scheduled_date >= ? AND w.scheduled_date <= ?'];
    const params = [date_start || '2026-01-01', date_end || '2027-01-01'];
    if (ctx.role === 'worker' && ctx.userId) {
      conds.push('(w.assigned_to_user_id = ? OR w.assigned_to LIKE ?)');
      params.push(ctx.userId, `%${ctx.userName}%`);
    }
    const rows = db.all(`SELECT w.id, w.display_number, w.status, w.scheduled_date, w.scheduled_time,
      w.assigned_to, u.name AS assigned_user_name,
      j.title AS job_title, c.name AS customer_name
      FROM work_orders w
      JOIN jobs j ON j.id = w.job_id
      JOIN customers c ON c.id = j.customer_id
      LEFT JOIN users u ON u.id = w.assigned_to_user_id
      WHERE ${conds.join(' AND ')}
      ORDER BY w.scheduled_date ASC, w.scheduled_time ASC`, params);

    const grouped = {};
    rows.forEach(r => {
      const date = r.scheduled_date ? String(r.scheduled_date).slice(0,10) : 'unscheduled';
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push({
        id: r.id, number: `WO-${r.display_number || ''}`, status: r.status,
        time: r.scheduled_time || '',
        customer: `${r.customer_name || ''} — ${r.job_title || ''}`,
        assignee: r.assigned_user_name || r.assigned_to || ''
      });
    });
    return grouped;
  }
};

tools.get_dashboard_summary = {
  description: 'Get a summary of key metrics: counts of open estimates, active WOs, unpaid invoices, A/R balance.',
  args: {},
  needs_user: 'read',
  handler: (args, ctx) => {
    const openEst = (db.get("SELECT COUNT(*) AS n FROM estimates WHERE status IN ('draft','sent')") || {}).n || 0;
    const activeWO = (db.get("SELECT COUNT(*) AS n FROM work_orders WHERE status IN ('scheduled','in_progress')") || {}).n || 0;
    const unpaid = (db.all("SELECT total, amount_paid FROM invoices WHERE status IN ('draft','sent','overdue')"));
    const arBalance = unpaid.reduce((s, inv) => s + (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0), 0);
    const overdueCount = (db.get("SELECT COUNT(*) AS n FROM invoices WHERE status='overdue'") || {}).n || 0;
    return {
      open_estimates: openEst,
      active_work_orders: activeWO,
      unpaid_invoices: unpaid.length,
      ar_balance: Math.round(arBalance * 100) / 100,
      overdue_invoices: overdueCount,
    };
  }
};

tools.navigate = {
  description: 'Generate a navigation link to a page. Validates the path.',
  args: { path: 'string (required) — e.g. /work-orders, /invoices?status=overdue' },
  needs_user: 'navigate',
  handler: ({ path }, ctx) => {
    const p = String(path || '').trim();
    // Reject protocol-relative, path traversal, backslashes
    if (!p.startsWith('/')) return { ok: false, error: 'Path must start with /' };
    if (p.startsWith('//') || p.startsWith('/\\')) return { ok: false, error: 'Protocol-relative paths not allowed' };
    if (p.includes('..')) return { ok: false, error: 'Path traversal not allowed' };
    if (p.includes('\\')) return { ok: false, error: 'Backslashes not allowed in paths' };
    return { ok: true, path: p };
  }
};

// ── Worker post-filter ──────────────────────────────────────────────
function filterForWorker(result, role) {
  if (role !== 'worker') return result;
  // Workers only get WO-based data; redact costs/prices/financial metrics
  if (result && typeof result === 'object') {
    if (Array.isArray(result)) {
      return result.map(r => filterForWorker(r, role));
    }
    const filtered = { ...result };
    delete filtered.unit_price;
    delete filtered.cost;
    delete filtered.line_total;
    delete filtered.total;
    delete filtered.amount_paid;
    if (filtered.balance !== undefined) delete filtered.balance;
    delete filtered.ar_balance;
    delete filtered.overdue_invoices;
    delete filtered.unpaid_invoices;
    delete filtered.open_estimates;
    delete filtered.active_work_orders;
    return filtered;
  }
  return result;
}

// ── Export ───────────────────────────────────────────────────────────
module.exports = {
  tools,
  list() {
    return Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description || '',
      args: t.args || {},
      needs_user: t.needs_user || 'read'
    }));
  },
  call(name, args, ctx) {
    const tool = tools[name];
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    // Worker permission check
    if (ctx.role === 'worker') {
      if (tool.needs_user === 'write') {
        return { ok: false, error: 'You don\'t have permission to perform write actions.' };
      }
      if (!WORKER_ALLOWED.includes(name)) {
        return { ok: false, error: 'You don\'t have access to that type of data.' };
      }
    }
    try {
      let result = tool.handler(args || {}, ctx);
      result = filterForWorker(result, ctx.role);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
};
