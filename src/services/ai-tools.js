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
const supabase = require('../db/supabase');
const { writeAudit } = require('./audit');
const { logAiChatError } = require('./ai-chat');
const scheduling = require('./scheduling');

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

function idsFrom(rows) {
  return [...new Set((rows || []).map(r => r.id).filter(id => id !== null && id !== undefined))];
}

function oneEmbedded(value) {
  return Array.isArray(value) ? (value[0] || {}) : (value || {});
}

async function vendorIdsByName(term) {
  const like = resolveQuery(term);
  if (!like) return [];
  const { data, error } = await supabase.from('vendors').select('id').ilike('name', like).limit(50);
  if (error) throw error;
  return idsFrom(data);
}

async function customerIdsByText(term) {
  const like = resolveQuery(term);
  if (!like) return [];
  const ids = new Set();
  for (const column of ['name', 'email', 'phone']) {
    const { data, error } = await supabase.from('customers').select('id').ilike(column, like).limit(50);
    if (error) throw error;
    idsFrom(data).forEach(id => ids.add(id));
  }
  return [...ids];
}

async function assignedWorkOrderIdsForWorker(ctx) {
  if (!ctx.userId) return [];
  const ids = new Set();
  const userName = String(ctx.userName || '').trim();

  let legacy = supabase.from('work_orders').select('id').eq('assigned_to_user_id', ctx.userId);
  const { data: legacyIds, error: legacyErr } = await legacy.limit(100);
  if (legacyErr) throw legacyErr;
  idsFrom(legacyIds).forEach(id => ids.add(id));

  if (userName) {
    const { data: nameIds, error: nameErr } = await supabase
      .from('work_orders')
      .select('id')
      .ilike('assigned_to', resolveQuery(userName))
      .limit(100);
    if (nameErr) throw nameErr;
    idsFrom(nameIds).forEach(id => ids.add(id));
  }

  const { data: linkedIds, error: linkedErr } = await supabase
    .from('work_order_assignees')
    .select('work_order_id')
    .eq('user_id', ctx.userId)
    .limit(100);
  if (linkedErr) throw linkedErr;
  (linkedIds || []).forEach(r => {
    if (r.work_order_id !== null && r.work_order_id !== undefined) ids.add(r.work_order_id);
  });

  return [...ids];
}

async function customerIdsForWorker(ctx) {
  const workOrderIds = await assignedWorkOrderIdsForWorker(ctx);
  if (!workOrderIds.length) return [];
  const { data, error } = await supabase
    .from('work_orders')
    .select('customer_id, jobs!left(customer_id)')
    .in('id', workOrderIds)
    .in('status', ['scheduled', 'in_progress', 'complete'])
    .limit(100);
  if (error) throw error;
  return [...new Set((data || []).map(r => r.customer_id || oneEmbedded(r.jobs).customer_id).filter(Boolean))];
}

async function workOrderIdsForFinancialSearch(term) {
  const like = resolveQuery(term);
  if (!like) return [];
  const ids = new Set();

  const addWorkOrders = rows => (rows || []).forEach(r => ids.add(r.id));

  const { data: byNumber, error: byNumberErr } = await supabase
    .from('work_orders')
    .select('id')
    .ilike('display_number', like)
    .limit(50);
  if (byNumberErr) throw byNumberErr;
  addWorkOrders(byNumber);

  const { data: customers, error: customersErr } = await supabase
    .from('customers')
    .select('id')
    .ilike('name', like)
    .limit(50);
  if (customersErr) throw customersErr;
  const customerIds = idsFrom(customers);
  if (customerIds.length) {
    const { data: byCustomer, error: byCustomerErr } = await supabase
      .from('work_orders')
      .select('id')
      .in('customer_id', customerIds)
      .limit(50);
    if (byCustomerErr) throw byCustomerErr;
    addWorkOrders(byCustomer);

    const { data: customerJobs, error: customerJobsErr } = await supabase
      .from('jobs')
      .select('id')
      .in('customer_id', customerIds)
      .limit(50);
    if (customerJobsErr) throw customerJobsErr;
    const customerJobIds = idsFrom(customerJobs);
    if (customerJobIds.length) {
      const { data: byCustomerJob, error: byCustomerJobErr } = await supabase
        .from('work_orders')
        .select('id')
        .in('job_id', customerJobIds)
        .limit(50);
      if (byCustomerJobErr) throw byCustomerJobErr;
      addWorkOrders(byCustomerJob);
    }
  }

  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id')
    .ilike('title', like)
    .limit(50);
  if (jobsErr) throw jobsErr;
  const jobIds = idsFrom(jobs);
  if (jobIds.length) {
    const { data: byJob, error: byJobErr } = await supabase
      .from('work_orders')
      .select('id')
      .in('job_id', jobIds)
      .limit(50);
    if (byJobErr) throw byJobErr;
    addWorkOrders(byJob);
  }

  return [...ids];
}

// ── Tool implementations ─────────────────────────────────────────────

const tools = {};

tools.search_customers = {
  description: 'Search customers by name, email, or phone.',
  args: { query: 'string (required) — partial name, email, or phone' },
  needs_user: 'read',
  handler: async ({ query }, ctx) => {
    const customerIds = await customerIdsByText(query);
    if (!customerIds.length) return [];
    let q = supabase.from('customers').select('id, name, email, phone, city, state').in('id', customerIds).limit(10);
    if (ctx.role === 'worker' && ctx.userId) {
      const workerCustomerIds = await customerIdsForWorker(ctx);
      if (workerCustomerIds.length) q = q.in('id', workerCustomerIds);
      else return []; // no assigned customers
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows || []).map(r => ({ id: r.id, name: r.name, email: r.email || '', phone: r.phone || '', city: r.city || '', state: r.state || '' }));
  }
};

tools.search_estimates = {
  description: 'Search estimates by number, job title, customer name, or filter by status.',
  args: { query: 'string (optional) — partial number, job, or customer name', status: 'string (optional) — draft|sent|accepted|rejected|expired' },
  needs_user: 'read',
  handler: async ({ query, status }, ctx) => {
    let q = supabase.from('estimates').select(`
      id, status, total, created_at,
      work_orders!inner(
        display_number,
        jobs!left(title, customers!left(name)),
        customers!left(name)
      )
    `).order('created_at', { ascending: false }).limit(10);

    if (status) q = q.eq('status', status);
    if (query) {
      const workOrderIds = await workOrderIdsForFinancialSearch(query);
      const estimateId = Number.parseInt(String(query).trim(), 10);
      const exactEstimateId = Number.isInteger(estimateId) && String(estimateId) === String(query).trim();
      if (workOrderIds.length && exactEstimateId) {
        q = q.or(`id.eq.${estimateId},work_order_id.in.(${workOrderIds.join(',')})`);
      } else if (workOrderIds.length) {
        q = q.in('work_order_id', workOrderIds);
      } else if (exactEstimateId) {
        q = q.eq('id', estimateId);
      } else {
        return [];
      }
    }

    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows || []).map(r => {
      const wo = oneEmbedded(r.work_orders);
      const job = oneEmbedded(wo.jobs);
      const directCustomer = oneEmbedded(wo.customers);
      const jobCustomer = oneEmbedded(job.customers);
      const customer = directCustomer.name ? directCustomer : jobCustomer;
      return {
        id: r.id, number: `EST-${wo.display_number || ''}`, status: r.status,
        total: Number(r.total) || 0, job_title: job.title || '',
        customer_name: customer.name || '', days_old: daysAgo(r.created_at)
      };
    });
  }
};

tools.search_invoices = {
  description: 'Search invoices by number, customer, job, or filter by status. Returns balance info.',
  args: { query: 'string (optional) — partial number, customer, or job', status: 'string (optional) — draft|sent|paid|overdue|void' },
  needs_user: 'read',
  handler: async ({ query, status }, ctx) => {
    let q = supabase.from('invoices').select(`
      id, status, total, amount_paid, due_date, created_at,
      work_orders!inner(
        display_number,
        jobs!left(title, customers!left(name)),
        customers!left(name)
      )
    `).order('created_at', { ascending: false }).limit(10);

    if (status) q = q.eq('status', status);
    if (query) {
      const workOrderIds = await workOrderIdsForFinancialSearch(query);
      const invoiceId = Number.parseInt(String(query).trim(), 10);
      const exactInvoiceId = Number.isInteger(invoiceId) && String(invoiceId) === String(query).trim();
      if (workOrderIds.length && exactInvoiceId) {
        q = q.or(`id.eq.${invoiceId},work_order_id.in.(${workOrderIds.join(',')})`);
      } else if (workOrderIds.length) {
        q = q.in('work_order_id', workOrderIds);
      } else if (exactInvoiceId) {
        q = q.eq('id', invoiceId);
      } else {
        return [];
      }
    }

    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows || []).map(r => {
      const wo = oneEmbedded(r.work_orders);
      const job = oneEmbedded(wo.jobs);
      const directCustomer = oneEmbedded(wo.customers);
      const jobCustomer = oneEmbedded(job.customers);
      const customer = directCustomer.name ? directCustomer : jobCustomer;
      const total = Number(r.total) || 0;
      const paid = Number(r.amount_paid) || 0;
      const bal = Math.round((total - paid) * 100) / 100;
      const due = r.due_date ? String(r.due_date).slice(0,10) : '';
      return {
        id: r.id, number: `INV-${wo.display_number || ''}`, status: r.status,
        total, amount_paid: paid, balance: bal,
        due_date: due, days_late: due ? Math.max(0, daysAgo(due)) : 0,
        customer_name: customer.name || '', job_title: job.title || ''
      };
    });
  }
};

tools.search_work_orders = {
  description: 'Search work orders by number, customer, job, or filter by status/scheduled_date.',
  args: { query: 'string (optional)', status: 'string (optional)', scheduled_date: 'string (optional)' },
  needs_user: 'read',
  handler: async ({ query, status, scheduled_date }, ctx) => {
    let q = supabase.from('work_orders').select(`
      id, display_number, status, scheduled_date, scheduled_time, assigned_to, assigned_to_user_id,
      jobs!left(title, customers!left(name)),
      customers!left(name),
      users!left(name)
    `).order('scheduled_date', { ascending: true }).order('scheduled_time', { ascending: true }).limit(10);

    if (status) q = q.eq('status', status);
    if (scheduled_date) q = q.eq('scheduled_date', scheduled_date);
    if (query) {
      const workOrderIds = await workOrderIdsForFinancialSearch(query);
      if (!workOrderIds.length) return [];
      q = q.in('id', workOrderIds);
    }
    if (ctx.role === 'worker' && ctx.userId) {
      const workerWorkOrderIds = await assignedWorkOrderIdsForWorker(ctx);
      if (!workerWorkOrderIds.length) return [];
      q = q.in('id', workerWorkOrderIds);
    }

    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows || []).map(r => {
      const job = oneEmbedded(r.jobs);
      const directCustomer = oneEmbedded(r.customers);
      const jobCustomer = oneEmbedded(job.customers);
      const customer = directCustomer.name ? directCustomer : jobCustomer;
      return {
        id: r.id, number: `WO-${r.display_number || ''}`, status: r.status,
        scheduled_date: r.scheduled_date ? String(r.scheduled_date).slice(0,10) : '',
        scheduled_time: r.scheduled_time || '',
        customer_name: customer.name || '', job_title: job.title || '',
        assignee: oneEmbedded(r.users).name || r.assigned_to || ''
      };
    });
  }
};

tools.search_bills = {
  description: 'Search bills by number, vendor name, or filter by status.',
  args: { query: 'string (optional)', status: 'string (optional)', vendor_name: 'string (optional)' },
  needs_user: 'read',
  handler: async ({ query, status, vendor_name }, ctx) => {
    let q = supabase.from('bills').select(`
      id, bill_number, status, total, amount_paid, bill_date, due_date,
      vendors!left(name)
    `).order('created_at', { ascending: false }).limit(10);

    if (status) q = q.eq('status', status);
    if (vendor_name) {
      const vendorIds = await vendorIdsByName(vendor_name);
      if (!vendorIds.length) return [];
      q = q.in('vendor_id', vendorIds);
    }
    if (query) {
      const vendorIds = await vendorIdsByName(query);
      const like = resolveQuery(query);
      q = vendorIds.length
        ? q.or(`bill_number.ilike.${like},vendor_id.in.(${vendorIds.join(',')})`)
        : q.ilike('bill_number', like);
    }

    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows || []).map(r => ({
      id: r.id, number: r.bill_number || `#${r.id}`, status: r.status,
      total: Number(r.total) || 0, amount_paid: Number(r.amount_paid) || 0,
      vendor_name: oneEmbedded(r.vendors).name || '', bill_date: r.bill_date || '', due_date: r.due_date || ''
    }));
  }
};

tools.get_schedule = {
  description: 'Get work orders scheduled within a date range, grouped by date.',
  args: { date_start: 'string (optional) — YYYY-MM-DD', date_end: 'string (optional) — YYYY-MM-DD', start_date: 'string (optional) — YYYY-MM-DD', end_date: 'string (optional) — YYYY-MM-DD', status: 'string (optional)', scheduled_date: 'string (optional)' },
  needs_user: 'read',
  handler: async ({ date_start, date_end, start_date, end_date, status, scheduled_date }, ctx) => {
    const fromDate = start_date || date_start || '2026-01-01';
    const toDate = end_date || date_end || '2027-01-01';
    let q = supabase.from('work_orders').select(`
      id, display_number, status, scheduled_date, scheduled_time, assigned_to, assigned_to_user_id,
      jobs!left(title, customers!left(name)),
      customers!left(name),
      users!left(name)
    `).order('scheduled_date', { ascending: true }).order('scheduled_time', { ascending: true });

    if (scheduled_date) {
      q = q.eq('scheduled_date', scheduled_date);
    } else {
      q = q.gte('scheduled_date', fromDate).lte('scheduled_date', toDate);
    }
    if (status) q = q.eq('status', status);
    if (ctx.role === 'worker' && ctx.userId) {
      const workerIds = await assignedWorkOrderIdsForWorker(ctx);
      if (workerIds.length) q = q.in('id', workerIds);
      else return {};
    }

    const { data: rows, error } = await q;
    if (error) throw error;
    const grouped = {};
    (rows || []).forEach(r => {
      const job = oneEmbedded(r.jobs);
      const directCustomer = oneEmbedded(r.customers);
      const jobCustomer = oneEmbedded(job.customers);
      const customer = directCustomer.name ? directCustomer : jobCustomer;
      const date = r.scheduled_date ? String(r.scheduled_date).slice(0,10) : 'unscheduled';
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push({
        id: r.id, number: `WO-${r.display_number || ''}`, status: r.status,
        time: r.scheduled_time || '',
        customer: `${customer.name || ''} — ${job.title || ''}`,
        assignee: oneEmbedded(r.users).name || r.assigned_to || ''
      });
    });
    return grouped;
  }
};

tools.get_dashboard_summary = {
  description: 'Get a summary of key metrics: counts of open estimates, active WOs, unpaid invoices, A/R balance.',
  args: {},
  needs_user: 'read',
  handler: async (args, ctx) => {
    const { count: openEst } = await supabase.from('estimates').select('*', { count: 'exact', head: true }).in('status', ['draft','sent']);
    const { count: activeWO } = await supabase.from('work_orders').select('*', { count: 'exact', head: true }).in('status', ['scheduled','in_progress']);
    const { data: unpaid } = await supabase.from('invoices').select('total, amount_paid').in('status', ['draft','sent','overdue']);
    const arBalance = (unpaid || []).reduce((s, inv) => s + (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0), 0);
    const { count: overdueCount } = await supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('status', 'overdue');
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
async function filterForWorker(result, role) {
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

// ── Mutation tools (Tier 3 — requires confirmation) ──────────────────

const MUTATION_TOOLS = {};

MUTATION_TOOLS.create_customer = {
  needs_user: 'write',
  async propose(args, ctx) {
    const cleanArgs = { ...(args || {}) };
    delete cleanArgs._customer_skip_missing;
    if (!cleanArgs.name || cleanArgs.name.trim().length < 2) return { error: 'Customer name is required (min 2 chars).' };
    const lines = [];
    lines.push(`Name: ${cleanArgs.name.trim()}`);
    if (cleanArgs.email) lines.push(`Email: ${cleanArgs.email.trim()}`);
    if (cleanArgs.phone) lines.push(`Phone: ${cleanArgs.phone.trim()}`);
    if (cleanArgs.contact_name) lines.push(`Contact: ${cleanArgs.contact_name.trim()}`);
    if (cleanArgs.address || cleanArgs.city || cleanArgs.state || cleanArgs.zip) {
      lines.push(`Address: ${[cleanArgs.address, cleanArgs.city, cleanArgs.state, cleanArgs.zip].filter(Boolean).join(', ')}`);
    }
    if (cleanArgs.billing_email) lines.push(`Billing email: ${cleanArgs.billing_email.trim()}`);
    if (cleanArgs.notes) lines.push(`Notes: ${cleanArgs.notes.trim()}`);
    return { summary_lines: lines, args_normalized: cleanArgs };
  },
  async execute(args, ctx) {
    const { data: newCustomer, error } = await supabase.from('customers').insert({
      name: args.name.trim(), email: (args.email || '').trim() || null,
      phone: (args.phone || '').trim() || null, address: (args.address || '').trim() || null,
      contact_name: (args.contact_name || '').trim() || null,
      city: (args.city || '').trim() || null, state: (args.state || '').trim() || null,
      zip: (args.zip || '').trim() || null, billing_email: (args.billing_email || '').trim() || null,
      notes: (args.notes || '').trim() || null,
    }).select('id').single();
    if (error) throw error;
    await writeAudit({ entityType: 'customer', entityId: newCustomer?.id, action: 'created_by_ai', before: null, after: { name: args.name.trim() }, source: 'ai', userId: ctx.userId });
    return { id: newCustomer?.id, name: args.name.trim(), href: `/customers/${newCustomer?.id}` };
  }
};

MUTATION_TOOLS.send_estimate = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: est, error: estError } = await supabase.from('estimates').select('id, status, total, work_order_id').eq('id', args.estimate_id).maybeSingle();
    if (estError) return { error: estError.message };
    if (!est) return { error: 'Estimate not found.' };
    if (est.status !== 'draft') return { error: `Estimate is "${est.status}" — must be draft to send.` };
    const { data: wo, error: woError } = await supabase.from('work_orders').select('display_number').eq('id', est.work_order_id).maybeSingle();
    if (woError) return { error: woError.message };
    const number = `EST-${wo ? wo.display_number : ''}`;
    return { summary_lines: [`Estimate: ${number}`, `Amount: $${Number(est.total).toFixed(2)}`, `Status: draft → sent`], args_normalized: args };
  },
  async execute(args, ctx) {
    const { data: est, error: estError } = await supabase.from('estimates').select('id, status').eq('id', args.estimate_id).maybeSingle();
    if (estError) throw estError;
    if (!est) return { error: 'Estimate not found.' };
    if (est.status !== 'draft') return { error: `Estimate is "${est.status}" — must be draft to send.` };
    // Generate .eml via the shared service (async — wrap in promise)
    try {
      const emailService = require('./estimate-email');
      emailService.sendEstimateEmail(est.id).then(async (result) => {
        if (result.filepath) console.log('[ai-send-estimate] .eml saved:', result.filepath);
      }).catch(e => console.error('[ai-send-estimate] .eml failed:', e.message));
    } catch(e) { console.error('[ai-send-estimate] service error:', e.message); }
    const { error: updateError } = await supabase.from('estimates').update({ status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', est.id);
    if (updateError) throw updateError;
    await writeAudit({ entityType: 'estimate', entityId: est.id, action: 'sent_by_ai', before: { status: 'draft' }, after: { status: 'sent' }, source: 'ai', userId: ctx.userId });
    return { id: est.id, href: `/estimates/${est.id}` };
  }
};

MUTATION_TOOLS.mark_invoice_paid = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: inv, error: invError } = await supabase.from('invoices').select('id, status, total, amount_paid, work_order_id').eq('id', args.invoice_id).maybeSingle();
    if (invError) return { error: invError.message };
    if (!inv) return { error: 'Invoice not found.' };
    if (inv.status === 'paid') return { error: 'Invoice is already paid.' };
    const balance = Math.round((Number(inv.total) - Number(inv.amount_paid)) * 100) / 100;
    let amount = Number(args.amount) || balance;
    if (amount > balance) { amount = balance; }
    const { data: wo, error: woError } = await supabase.from('work_orders').select('display_number').eq('id', inv.work_order_id).maybeSingle();
    if (woError) return { error: woError.message };
    const number = `INV-${wo ? wo.display_number : ''}`;
    const lines = [`Invoice: ${number}`, `Amount: $${amount.toFixed(2)}`, `Balance before: $${balance.toFixed(2)}`];
    if (amount !== (Number(args.amount) || balance)) lines.push('(adjusted to outstanding balance)');
    const today = new Date().toISOString().slice(0,10);
    return { summary_lines: lines, args_normalized: { ...args, amount, payment_date: args.payment_date || today } };
  },
  async execute(args, ctx) {
    const { data: inv, error: invError } = await supabase.from('invoices').select('id, status, total, amount_paid').eq('id', args.invoice_id).maybeSingle();
    if (invError) throw invError;
    if (!inv) return { error: 'Invoice not found.' };
    if (inv.status === 'paid') return { error: 'Invoice is already paid.' };
    const amount = Number(args.amount);
    const newAmt = (Number(inv.amount_paid) || 0) + amount;
    const newStatus = newAmt >= Number(inv.total) ? 'paid' : 'sent';
    const { error: updateError } = await supabase.from('invoices').update({ amount_paid: newAmt, status: newStatus, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', inv.id);
    if (updateError) throw updateError;
    // Post JE via accounting-posting
    try {
      const posting = require('../services/accounting-posting');
      await posting.postPaymentReceived(inv, amount, { userId: ctx.userId });
    } catch(e) { console.warn('JE post for payment failed:', e.message); }
    await writeAudit({ entityType: 'invoice', entityId: inv.id, action: 'paid_by_ai', before: { status: inv.status, amount_paid: inv.amount_paid }, after: { status: newStatus, amount_paid: newAmt }, source: 'ai', userId: ctx.userId });
    return { id: inv.id, href: `/invoices/${inv.id}` };
  }
};

MUTATION_TOOLS.approve_bill = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: bill, error: billError } = await supabase.from('bills').select('id, bill_number, status, total, vendor_id').eq('id', args.bill_id).maybeSingle();
    if (billError) return { error: billError.message };
    if (!bill) return { error: 'Bill not found.' };
    if (bill.status !== 'draft') return { error: `Bill is "${bill.status}" — must be draft to approve.` };
    const { data: vendor, error: vendorError } = await supabase.from('vendors').select('name').eq('id', bill.vendor_id).maybeSingle();
    if (vendorError) return { error: vendorError.message };
    return { summary_lines: [`Bill: ${bill.bill_number || '#' + bill.id}`, `Vendor: ${vendor ? vendor.name : 'Unknown'}`, `Total: $${Number(bill.total).toFixed(2)}`, `Status: draft → approved`], args_normalized: args };
  },
  async execute(args, ctx) {
    const { data: bill, error: billError } = await supabase.from('bills').select('id, bill_number, bill_date, status, total, tax_amount, vendor_id').eq('id', args.bill_id).maybeSingle();
    if (billError) throw billError;
    if (!bill) return { error: 'Bill not found.' };
    if (bill.status !== 'draft') return { error: `Bill is "${bill.status}" — must be draft to approve.` };
    const { error: updateError } = await supabase.from('bills').update({ status: 'approved', approved_by_user_id: ctx.userId, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', bill.id);
    if (updateError) throw updateError;
    try {
      const { data: lines, error: linesError } = await supabase.from('bill_lines').select('*').eq('bill_id', bill.id);
      if (linesError) throw linesError;
      const posting = require('../services/accounting-posting');
      await posting.postBillApproved(bill, lines, { userId: ctx.userId });
    } catch(e) { console.warn('JE post for bill approve failed:', e.message); }
    await writeAudit({ entityType: 'bill', entityId: bill.id, action: 'approved_by_ai', before: { status: 'draft' }, after: { status: 'approved' }, source: 'ai', userId: ctx.userId });
    return { id: bill.id, href: `/bills/${bill.id}` };
  }
};

MUTATION_TOOLS.add_wo_note = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: wo, error } = await supabase.from('work_orders').select('id, display_number, assigned_to_user_id, assigned_to').eq('id', args.wo_id).maybeSingle();
    if (error) return { error: error.message };
    if (!wo) return { error: 'Work order not found.' };
    if (ctx.role === 'worker') {
      const assignedIds = await assignedWorkOrderIdsForWorker(ctx);
      const isAssigned = assignedIds.includes(Number(wo.id));
      if (!isAssigned) return { error: 'You can only add notes to work orders assigned to you.' };
    }
    if (!args.body || args.body.trim().length < 2) return { error: 'Note body is required (min 2 chars).' };
    return { summary_lines: [`WO: ${wo.display_number ? 'WO-' + wo.display_number : '#' + wo.id}`, `Note: ${args.body.trim().slice(0, 100)}`], args_normalized: args };
  },
  async execute(args, ctx) {
    const proposal = await MUTATION_TOOLS.add_wo_note.propose(args, ctx);
    if (proposal.error) return { error: proposal.error };
    const { error } = await supabase.from('wo_notes').insert({ work_order_id: args.wo_id, user_id: ctx.userId, body: args.body.trim(), created_at: new Date().toISOString() });
    if (error) throw error;
    await writeAudit({ entityType: 'work_order', entityId: args.wo_id, action: 'note_added_by_ai', before: null, after: { note: args.body.trim().slice(0,100) }, source: 'ai', userId: ctx.userId });
    return { id: args.wo_id, href: `/work-orders/${args.wo_id}` };
  }
};

MUTATION_TOOLS.schedule_wo = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: wo, error: woError } = await supabase.from('work_orders').select('*').eq('id', args.wo_id).maybeSingle();
    if (woError) return { error: woError.message };
    if (!wo) return { error: 'Work order not found.' };

    const date = args.date;
    if (!date) return { error: 'A date is required. Please specify a date like "May 14" or "tomorrow".' };
    // Reject past dates
    const today = new Date().toISOString().slice(0, 10);
    if (date < today) return { error: `Cannot schedule WOs in the past (${date}). Please pick a future date.` };

    const time = args.time || null;
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return { error: `Invalid time format "${time}". Please use HH:MM format (e.g., "09:00" or "14:30").` };
    }

    const assigneeUserId = args.assignee_user_id || null;
    let assigneeName = args.assignee_name || null;

    // If assignee_user_id provided, look up name
    if (assigneeUserId) {
      const { data: u, error: userError } = await supabase.from('users').select('name').eq('id', assigneeUserId).maybeSingle();
      if (userError) return { error: userError.message };
      if (u) assigneeName = u.name;
    }

    // If only name provided, try to resolve to user_id for conflict check
    let resolvedUserId = assigneeUserId;
    if (!assigneeUserId && assigneeName) {
      const resolved = await scheduling.resolveUserName(assigneeName);
      if (resolved.user) {
        resolvedUserId = resolved.user.id;
        assigneeName = resolved.user.name;
      } else if (resolved.matches) {
        // Multiple matches — still proceed with conflict check just skip if ambiguous
      }
    }

    // Conflict check
    const conflicts = await scheduling.findScheduleConflicts({
      assignee_user_id: resolvedUserId,
      date,
      time,
      duration_hours: parseInt(process.env.WO_DEFAULT_DURATION_HOURS || '4', 10),
      exclude_wo_id: wo.id
    });

    let summary = [
      `Work order: WO-${wo.display_number || ''}`,
      `Date: ${scheduling.formatDate(date)}`,
    ];
    if (time) summary.push(`Time: ${scheduling.formatTime(time)}`);
    if (assigneeName) summary.push(`Assignee: ${assigneeName}`);

    const warnings = conflicts.map(c =>
      `⚠ ${assigneeName || 'Assignee'} is already on WO-${c.display_number} (${c.customer_name}) at ${c.scheduled_time} — ${c.overlap_minutes}min overlap`
    );

    return { summary_lines: summary, args_normalized: { ...args, date, time, assignee_user_id: assigneeUserId, assignee_name: assigneeName }, warnings };
  },
  async execute(args, ctx) {
    const proposal = await MUTATION_TOOLS.schedule_wo.propose(args, ctx);
    if (proposal.error) return { error: proposal.error };
    const normalized = proposal.args_normalized || args;
    const updateFields = {};
    if (normalized.date) updateFields.scheduled_date = normalized.date;
    if (normalized.time) updateFields.scheduled_time = normalized.time;
    if (normalized.assignee_user_id) updateFields.assigned_to_user_id = normalized.assignee_user_id;
    if (normalized.assignee_name) updateFields.assigned_to = normalized.assignee_name;
    updateFields.updated_at = new Date().toISOString();
    const { error: updateError } = await supabase.from('work_orders').update(updateFields).eq('id', args.wo_id);
    if (updateError) throw updateError;
    await writeAudit({ entityType: 'work_order', entityId: args.wo_id, action: 'scheduled_by_ai', before: {}, after: { scheduled_date: normalized.date, scheduled_time: normalized.time, assigned_to: normalized.assignee_name }, source: 'ai', userId: ctx.userId });
    return { id: args.wo_id, href: `/work-orders/${args.wo_id}` };
  }
};

MUTATION_TOOLS.reschedule_wo = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: wo, error: woError } = await supabase.from('work_orders').select('*').eq('id', args.wo_id).maybeSingle();
    if (woError) return { error: woError.message };
    if (!wo) return { error: 'Work order not found.' };

    const date = args.new_date;
    if (!date) return { error: 'A new date is required.' };
    const today = new Date().toISOString().slice(0, 10);
    if (date < today) return { error: `Cannot reschedule WOs to the past (${date}). Pick a future date.` };

    const time = args.new_time || wo.scheduled_time || null;
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return { error: `Invalid time format "${time}". Use HH:MM.` };
    }

    // Conflict check — exclude current WO
    const assigneeUserId = wo.assigned_to_user_id || null;
    const conflicts = await scheduling.findScheduleConflicts({
      assignee_user_id: assigneeUserId,
      date,
      time,
      duration_hours: parseInt(process.env.WO_DEFAULT_DURATION_HOURS || '4', 10),
      exclude_wo_id: wo.id
    });

    const assigneeName = wo.assigned_to || '';
    let summary = [
      `Work order: WO-${wo.display_number || ''}`,
      `New date: ${scheduling.formatDate(date)}`,
    ];
    if (time) summary.push(`Time: ${scheduling.formatTime(time)}`);
    if (assigneeName) summary.push(`Assignee: ${assigneeName}`);

    const warnings = conflicts.map(c =>
      `⚠ ${assigneeName || 'Assignee'} is already on WO-${c.display_number} (${c.customer_name}) at ${c.scheduled_time} — ${c.overlap_minutes}min overlap`
    );

    return { summary_lines: summary, args_normalized: { ...args, date, time }, warnings };
  },
  async execute(args, ctx) {
    const proposal = await MUTATION_TOOLS.reschedule_wo.propose(args, ctx);
    if (proposal.error) return { error: proposal.error };
    const normalized = proposal.args_normalized || args;
    const updateFields = {};
    if (normalized.date) updateFields.scheduled_date = normalized.date;
    if (normalized.time) updateFields.scheduled_time = normalized.time;
    updateFields.updated_at = new Date().toISOString();
    const { error: updateError } = await supabase.from('work_orders').update(updateFields).eq('id', args.wo_id);
    if (updateError) throw updateError;
    await writeAudit({ entityType: 'work_order', entityId: args.wo_id, action: 'rescheduled_by_ai', before: {}, after: { scheduled_date: normalized.date, scheduled_time: normalized.time }, source: 'ai', userId: ctx.userId });
    return { id: args.wo_id, href: `/work-orders/${args.wo_id}` };
  }
};

MUTATION_TOOLS.assign_wo = {
  needs_user: 'write',
  async propose(args, ctx) {
    const { data: wo, error: woError } = await supabase.from('work_orders').select('*').eq('id', args.wo_id).maybeSingle();
    if (woError) return { error: woError.message };
    if (!wo) return { error: 'Work order not found.' };

    let assigneeUserId = args.assignee_user_id;
    let assigneeName = args.assignee_name;

    // Resolve by name if only assignee_name provided
    if (!assigneeUserId && assigneeName) {
      const resolved = await scheduling.resolveUserName(assigneeName);
      if (resolved.error) return { error: resolved.error };
      if (resolved.matches) {
        return { suggest_disambiguation: true, matches: resolved.matches.map(m => ({ id: m.id, name: m.name, email: m.email })) };
      }
      assigneeUserId = resolved.user.id;
      assigneeName = resolved.user.name;
    }

    if (!assigneeUserId && !assigneeName) {
      return { error: 'Please specify who to assign this to.' };
    }

    // If we have a user_id but no name, look it up
    if (assigneeUserId && !assigneeName) {
      const { data: u, error: userError } = await supabase.from('users').select('name').eq('id', assigneeUserId).maybeSingle();
      if (userError) return { error: userError.message };
      if (u) assigneeName = u.name;
    }

    // Conflict check if assigned to a user
    const conflicts = wo.scheduled_date ? await scheduling.findScheduleConflicts({
      assignee_user_id: assigneeUserId,
      date: wo.scheduled_date,
      time: wo.scheduled_time,
      duration_hours: parseInt(process.env.WO_DEFAULT_DURATION_HOURS || '4', 10),
      exclude_wo_id: wo.id
    }) : [];

    let summary = [
      `Work order: WO-${wo.display_number || ''}`,
      `New assignee: ${assigneeName}`,
    ];
    if (wo.scheduled_date) summary.push(`Date: ${scheduling.formatDate(wo.scheduled_date)}`);

    const warnings = conflicts.map(c =>
      `⚠ ${assigneeName} is already on WO-${c.display_number} (${c.customer_name}) at ${c.scheduled_time} — ${c.overlap_minutes}min overlap`
    );

    return { summary_lines: summary, args_normalized: { ...args, assignee_user_id: assigneeUserId, assignee_name: assigneeName }, warnings };
  },
  async execute(args, ctx) {
    const proposal = await MUTATION_TOOLS.assign_wo.propose(args, ctx);
    if (proposal.error) return { error: proposal.error };
    if (proposal.suggest_disambiguation) return proposal;
    const normalized = proposal.args_normalized || args;
    const updateFields = {};
    if (normalized.assignee_user_id) updateFields.assigned_to_user_id = normalized.assignee_user_id;
    if (normalized.assignee_name) updateFields.assigned_to = normalized.assignee_name;
    updateFields.updated_at = new Date().toISOString();
    const { error: updateError } = await supabase.from('work_orders').update(updateFields).eq('id', args.wo_id);
    if (updateError) throw updateError;
    await writeAudit({ entityType: 'work_order', entityId: args.wo_id, action: 'assigned_by_ai', before: {}, after: { assigned_to: normalized.assignee_name }, source: 'ai', userId: ctx.userId });
    return { id: args.wo_id, href: `/work-orders/${args.wo_id}` };
  }
};

// ── Mutation arg schemas ─────────────────────────────────────────────
function getMutationArgs(name) {
  const schemas = {
    create_customer: 'name: string (required), email: string (optional), phone: string (optional), address: string (optional), city: string (optional), state: string (optional), zip: string (optional), billing_email: string (optional), notes: string (optional)',
    send_estimate: 'estimate_id: number (required)',
    mark_invoice_paid: 'invoice_id: number (required), amount: number (optional, defaults to outstanding balance)',
    approve_bill: 'bill_id: number (required)',
    add_wo_note: 'wo_id: number (required), body: string (required)',
    schedule_wo: 'wo_id: number (required), date: string (required — YYYY-MM-DD or relative like "tomorrow"), time: string (optional — HH:MM), assignee_user_id: number (optional), assignee_name: string (optional)',
    reschedule_wo: 'wo_id: number (required), new_date: string (required — YYYY-MM-DD or relative), new_time: string (optional — HH:MM)',
    assign_wo: 'wo_id: number (required), assignee_user_id: number (optional), assignee_name: string (optional — fuzzy-matched)',
  };
  return schemas[name] || {};
}

// ── Exports ──────────────────────────────────────────────────────────
// Mutation tools are NOT in the `tools` object visible to LLM.
// They're only callable via the confirmation flow.
const mutationList = {};
Object.keys(MUTATION_TOOLS).forEach(k => {
  mutationList[k] = { needs_user: 'write', description: '', args: {}, handler: MUTATION_TOOLS[k].execute };
});

// Merge mutation tools into the main tool list (for LLM visibility)
// but mark them as 'write' so the orchestrator handles confirmation
Object.entries(MUTATION_TOOLS).forEach(([name, t]) => {
  tools[name] = {
    description: ({
      create_customer: 'Create a new customer record. Call this when the user says "add" or "create a customer".',
      send_estimate: 'Send an estimate to the customer (flips draft→sent). Call this when the user says "send estimate".',
      mark_invoice_paid: 'Mark an invoice as paid. Call this when the user says "mark paid" or "pay invoice".',
      approve_bill: 'Approve a draft bill (flips draft→approved). Call this when the user says "approve bill".',
      add_wo_note: 'Add a note to a work order. Call this when the user says "add a note" or "leave a note".',
      schedule_wo: 'Schedule a work order on a specific date/time with an assignee. Call this when the user says "schedule", "assign", or "book" a WO for a date.',
      reschedule_wo: 'Change the date/time of an already-scheduled work order. Call this when the user says "reschedule", "move", "push back", or "change the date" of a WO.',
      assign_wo: 'Assign a work order to a worker. Call this when the user says "assign WO to [name]" or "reassign".',
    })[name] || `[ACTION] ${name.replace(/_/g, ' ')}`,
    args: getMutationArgs(name),
    needs_user: 'write',
    handler: t.execute
  };
});
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
  async call(name, args, ctx) {
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
      let result = await tool.handler(args || {}, ctx);
      result = await filterForWorker(result, ctx.role);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  // Tier 3: propose a mutation (validate + generate summary)
  async propose(name, args, ctx) {
    if (!MUTATION_TOOLS[name]) return { error: `Unknown mutation tool: ${name}` };
    const tool = MUTATION_TOOLS[name];
    // Manager+admin only for most mutations
    if (ctx.role === 'worker' && name !== 'add_wo_note') {
      return { error: 'Only managers and admins can perform this action.' };
    }
    return await tool.propose(args, ctx);
  },
  // Tier 3: execute a confirmed mutation
  async executeMutation(name, args, ctx) {
    if (!MUTATION_TOOLS[name]) return { ok: false, error: `Unknown mutation tool: ${name}` };
    if (ctx.role === 'worker' && name !== 'add_wo_note') {
      return { ok: false, error: 'Only managers and admins can perform this action.' };
    }
    try {
      const result = await MUTATION_TOOLS[name].execute(args, ctx);
      return { ok: true, result };
    } catch (e) {
      logAiChatError({ userId: ctx?.userId, toolName: name, errorType: 'tool_error', errorMessage: e.message, errorStack: e.stack });
      return { ok: false, error: e.message };
    }
  },
  // List mutation tools (for confirmation flow — not exposed to LLM)
  listMutationTools() {
    return Object.keys(MUTATION_TOOLS);
  }
};
