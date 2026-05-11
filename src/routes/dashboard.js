/**
 * Dashboard route. Mounted at GET /.
 *
 * Round 13: the modern operational dashboard (today-focused schedule, action queue,
 * activity stream) is the default at "/". The earlier KPI-card dashboard has been
 * moved to "/dashboard-classic" for reference and easy revert.
 */

const express = require('express');
const supabase = require('../db/supabase');
const timeline = require('../services/timeline');

const router = express.Router();

// Classic dashboard handler (was the original "/")
router.get('/dashboard-classic', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);

  const [{ count: openEstimates }, { count: scheduledWOs }, { count: unpaidInvoices }, { data: arData },
         { data: revMonthData }, { data: revYTDData },
         { count: overdueCount }, { data: overdueBalData },
         { count: customerCount }, { count: jobCount }] = await Promise.all([
    supabase.from('estimates').select('*', { count: 'exact', head: true }).in('status', ['draft', 'sent']),
    supabase.from('work_orders').select('*', { count: 'exact', head: true }).in('status', ['scheduled', 'in_progress']),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).in('status', ['sent', 'overdue']),
    supabase.from('invoices').select('total, amount_paid').in('status', ['sent', 'overdue']),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentMonth + '-01'),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentYear + '-01-01'),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('status', 'sent').not('due_date', 'is', null).lt('due_date', today),
    supabase.from('invoices').select('total, amount_paid').eq('status', 'sent').not('due_date', 'is', null).lt('due_date', today),
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('jobs').select('*', { count: 'exact', head: true }),
  ]);

  const arBalance = (arData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);
  const revenueThisMonth = (revMonthData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const revenueYTD = (revYTDData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const overdueBalance = (overdueBalData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);

  // Activity stream (UNION ALL equivalent — 3 separate queries + JS merge)
  const [woAct, estAct, invAct] = await Promise.all([
    supabase.from('work_orders').select('id, display_number, status, created_at, jobs!inner(title, customers!inner(id, name))').order('created_at', { ascending: false }).limit(10),
    supabase.from('estimates').select('id, status, created_at, total, work_orders!inner(display_number, jobs!inner(title, customers!inner(id, name)))').order('created_at', { ascending: false }).limit(10),
    supabase.from('invoices').select('id, status, created_at, total, work_orders!inner(display_number, jobs!inner(title, customers!inner(id, name)))').order('created_at', { ascending: false }).limit(10),
  ]);

  const activity = [
    ...(woAct.data || []).map(r => ({
      type: 'work_order', id: r.id, number: 'WO-' + r.display_number,
      status: r.status, created_at: r.created_at, total: null,
      job_id: r.jobs?.id, job_title: r.jobs?.title,
      customer_id: r.jobs?.customers?.id, customer_name: r.jobs?.customers?.name,
    })),
    ...(estAct.data || []).map(r => ({
      type: 'estimate', id: r.id, number: 'EST-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      job_title: r.work_orders?.jobs?.title,
      customer_name: r.work_orders?.jobs?.customers?.name,
    })),
    ...(invAct.data || []).map(r => ({
      type: 'invoice', id: r.id, number: 'INV-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      job_title: r.work_orders?.jobs?.title,
      customer_name: r.work_orders?.jobs?.customers?.name,
    })),
  ].sort((a, b) => b.created_at?.localeCompare(a.created_at || '') || 0).slice(0, 10);

  res.render('dashboard/index', {
    title: 'Dashboard',
    activeNav: 'dashboard',
    openEstimates: openEstimates || 0, scheduledWOs: scheduledWOs || 0,
    unpaidInvoices: unpaidInvoices || 0, arBalance,
    revenueThisMonth, revenueYTD,
    overdueCount: overdueCount || 0, overdueBalance,
    activity, customerCount: customerCount || 0, jobCount: jobCount || 0,
  });
});

// =============================================================================
// "/" — the modern operational dashboard (today-focused schedule list,
// asymmetric action queues, denser typography, flat right-rail action queue).
// The earlier KPI-card dashboard is at /dashboard-classic.
// =============================================================================
router.get('/', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);

  // ---------- Timeline: today's activity feed ----------
  const userId = req.session?.userId || null;
  const userRole = await (async () => {
    try { const { data: u } = await supabase.from('users').select('role').eq('id', userId).maybeSingle(); return u ? u.role : 'admin'; } catch(e) { return 'admin'; }
  })();
  const dayTimeline = await timeline.buildDayTimeline({ date: today, userId, workerOnly: userRole === 'worker' });

  // ---------- Schedule: tomorrow preview ----------
  const { data: tomorrowWOs } = await supabase
    .from('work_orders')
    .select('id, display_number, scheduled_time, jobs!inner(title, customers!inner(name)), assigned_to_user_id, users!left(name)')
    .eq('scheduled_date', tomorrow)
    .in('status', ['scheduled', 'in_progress'])
    .order('scheduled_time', { ascending: true, nullsFirst: false });

  const tomorrowMapped = (tomorrowWOs || []).map(r => ({
    id: r.id, display_number: r.display_number, scheduled_time: r.scheduled_time,
    job_title: r.jobs?.title, customer_name: r.jobs?.customers?.name,
    user_name: r.users?.name, assigned_to: r.assigned_to_user_id,
  }));
  const tomorrowCount = tomorrowMapped.length;
  const tomorrowPreview = tomorrowMapped.slice(0, 3);

  // ---------- Schedule: this week (peek) ----------
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { count: upcomingThisWeek } = await supabase
    .from('work_orders')
    .select('*', { count: 'exact', head: true })
    .gte('scheduled_date', tomorrow)
    .lte('scheduled_date', weekEnd)
    .in('status', ['scheduled', 'in_progress']);

  // ---------- Action queues ----------
  // 1. Estimates ready to send
  const [{ data: estimatesToSend }, { count: estimatesToSendCount }] = await Promise.all([
    supabase.from('estimates')
      .select('id, total, created_at, work_orders!inner(display_number, jobs!inner(title, customers!inner(name)))')
      .eq('status', 'draft').order('created_at', { ascending: false }).limit(5),
    supabase.from('estimates').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
  ]);
  const estMapped = (estimatesToSend || []).map(r => ({
    id: r.id, display_number: r.work_orders?.display_number,
    total: r.total, customer_name: r.work_orders?.jobs?.customers?.name, created_at: r.created_at,
  }));

  // 2. Invoices overdue
  const [{ data: overdueInvoices }, { count: overdueInvoicesCount }, { data: overdueSumData }] = await Promise.all([
    supabase.from('invoices')
      .select('id, total, amount_paid, due_date, work_orders!inner(display_number, jobs!inner(title, customers!inner(name)))')
      .in('status', ['sent', 'overdue']).not('due_date', 'is', null).lt('due_date', today)
      .order('due_date', { ascending: true }).limit(5),
    supabase.from('invoices').select('*', { count: 'exact', head: true })
      .in('status', ['sent', 'overdue']).not('due_date', 'is', null).lt('due_date', today),
    supabase.from('invoices').select('total, amount_paid')
      .in('status', ['sent', 'overdue']).not('due_date', 'is', null).lt('due_date', today),
  ]);
  const invMapped = (overdueInvoices || []).map(r => ({
    id: r.id, display_number: r.work_orders?.display_number,
    total: r.total, amount_paid: r.amount_paid, due_date: r.due_date,
    customer_name: r.work_orders?.jobs?.customers?.name,
    days_late: Math.floor((Date.now() - new Date(r.due_date).getTime()) / 86400000),
  }));
  const overdueTotal = (overdueSumData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);

  // 3. Bills awaiting approval
  let billsToApproveCount = 0;
  let billsToApproveTotal = 0;
  let billsToApprove = [];
  let billsMapped = [];
  try {
    const [{ count: bc }, { data: bd }, { data: bl }] = await Promise.all([
      supabase.from('bills').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
      supabase.from('bills').select('total').eq('status', 'draft'),
      supabase.from('bills').select('id, bill_number, total, due_date, vendors!inner(name)').eq('status', 'draft').order('created_at', { ascending: false }).limit(5),
    ]);
    billsToApproveCount = bc || 0;
    billsToApproveTotal = (bd || []).reduce((s, r) => s + Number(r.total || 0), 0);
    billsMapped = (bl || []).map(r => ({
      id: r.id, bill_number: r.bill_number, total: r.total, due_date: r.due_date,
      vendor_name: r.vendors?.name,
    }));
  } catch (e) {}

  // 4. Stale estimates
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: staleEstimates } = await supabase
    .from('estimates')
    .select('id, total, sent_at, work_orders!inner(display_number, jobs!inner(title, customers!inner(name)))')
    .eq('status', 'sent').not('sent_at', 'is', null).lt('sent_at', weekAgo)
    .order('sent_at', { ascending: true }).limit(5);
  const staleMapped = (staleEstimates || []).map(r => ({
    id: r.id, display_number: r.work_orders?.display_number,
    total: r.total, customer_name: r.work_orders?.jobs?.customers?.name,
    sent_at: r.sent_at,
    days_since_sent: Math.floor((Date.now() - new Date(r.sent_at).getTime()) / 86400000),
  }));
  const staleEstimatesCount = staleMapped.length;

  // ---------- Activity stream ----------
  const todayWoIds = dayTimeline.map(d => d.wo_id).filter(Boolean);
  const limitRecords = 12;

  const [woAct, estAct, invAct] = await Promise.all([
    supabase.from('work_orders')
      .select('id, display_number, status, created_at, jobs!inner(title, customers!inner(name))')
      .order('created_at', { ascending: false }).limit(limitRecords),
    supabase.from('estimates')
      .select('id, status, created_at, total, work_orders!inner(display_number, jobs!inner(title, customers!inner(name)))')
      .order('created_at', { ascending: false }).limit(limitRecords),
    supabase.from('invoices')
      .select('id, status, created_at, total, work_orders!inner(display_number, jobs!inner(title, customers!inner(name)))')
      .order('created_at', { ascending: false }).limit(limitRecords),
  ]);

  let activity = [
    ...(woAct.data || []).filter(r => !todayWoIds.includes(r.id)).map(r => ({
      type: 'work_order', id: r.id, number: 'WO-' + r.display_number,
      status: r.status, created_at: r.created_at, total: null,
      job_title: r.jobs?.title, customer_name: r.jobs?.customers?.name,
    })),
    ...(estAct.data || []).map(r => ({
      type: 'estimate', id: r.id, number: 'EST-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      job_title: r.work_orders?.jobs?.title,
      customer_name: r.work_orders?.jobs?.customers?.name,
    })),
    ...(invAct.data || []).map(r => ({
      type: 'invoice', id: r.id, number: 'INV-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      job_title: r.work_orders?.jobs?.title,
      customer_name: r.work_orders?.jobs?.customers?.name,
    })),
  ].sort((a, b) => b.created_at?.localeCompare(a.created_at || '') || 0).slice(0, limitRecords);

  // ---------- Bottom metrics ----------
  const [{ data: arData }, { data: revMonthData }, { data: revYTDData },
         { count: customerCount }, { data: activeJobs }] = await Promise.all([
    supabase.from('invoices').select('total, amount_paid').in('status', ['sent', 'overdue']),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentMonth + '-01'),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentYear + '-01-01'),
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['estimating', 'scheduled', 'in_progress']),
  ]);

  const arBalance = (arData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);
  const revenueThisMonth = (revMonthData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const revenueYTD = (revYTDData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const jobsActive = activeJobs?.length || 0;

  res.render('dashboard/v2', {
    title: 'Dashboard',
    activeNav: 'dashboard',
    today, tomorrow,
    dayTimeline, tomorrowPreview, tomorrowCount, upcomingThisWeek: upcomingThisWeek || 0,
    estimatesToSend: estMapped, estimatesToSendCount: estimatesToSendCount || 0,
    overdueInvoices: invMapped, overdueInvoicesCount: overdueInvoicesCount || 0, overdueTotal,
    billsToApprove: billsMapped, billsToApproveCount, billsToApproveTotal,
    staleEstimates: staleMapped, staleEstimatesCount,
    activity,
    arBalance, revenueThisMonth, revenueYTD, customerCount: customerCount || 0, jobsActive,
    serverTime: new Date().toISOString(),
  });
});

module.exports = router;
