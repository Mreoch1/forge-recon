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

// Compatibility alias for older links and the FORGE fallback path. The classic
// KPI dashboard was renamed to /dashboard-classic, but /dashboard may still be
// bookmarked or present in cached pages.
router.get('/dashboard', (req, res) => res.redirect(302, '/dashboard-classic'));

const WO_DASHBOARD_SELECT = 'id, display_number, status, created_at, customer_id, customers!left(id, name), jobs!left(id, title, customers!left(id, name))';
const EST_DASHBOARD_SELECT = 'id, status, created_at, total, work_orders!left(display_number, customer_id, customers!left(id, name), jobs!left(id, title, customers!left(id, name)))';
const INV_DASHBOARD_SELECT = 'id, status, created_at, total, work_orders!left(display_number, customer_id, customers!left(id, name), jobs!left(id, title, customers!left(id, name)))';

function displayForWorkOrder(wo) {
  const customer = wo?.customers || wo?.jobs?.customers || {};
  const customerName = customer.name || '';
  return {
    job_id: wo?.jobs?.id,
    job_title: wo?.jobs?.title || (customerName ? `${customerName} work order` : 'Customer work order'),
    customer_id: customer.id,
    customer_name: customerName,
  };
}

function displayForNestedWorkOrder(row) {
  return displayForWorkOrder(row?.work_orders || {});
}

function assertDashboardRead(result, label) {
  if (result?.error) {
    const err = new Error(`${label}: ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }
  return result || {};
}

async function checkedDashboardRead(query, label) {
  return assertDashboardRead(await query, label);
}

// Classic dashboard handler (was the original "/")
router.get('/dashboard-classic', async (req, res) => {
  if (req.session?.role === 'worker') return res.redirect('/work-orders');

  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);

  const [{ count: openEstimates }, { count: scheduledWOs }, { count: unpaidInvoices }, { data: arData },
         { data: revMonthData }, { data: revYTDData },
         { count: overdueCount }, { data: overdueBalData },
         { count: customerCount }, { count: workOrderCount }] = await Promise.all([
    supabase.from('estimates').select('*', { count: 'exact', head: true }).in('status', ['draft', 'sent']),
    supabase.from('work_orders').select('*', { count: 'exact', head: true }).in('status', ['scheduled', 'in_progress']),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).in('status', ['sent', 'overdue']),
    supabase.from('invoices').select('total, amount_paid').in('status', ['sent', 'overdue']),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentMonth + '-01'),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentYear + '-01-01'),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('status', 'sent').not('due_date', 'is', null).lt('due_date', today),
    supabase.from('invoices').select('total, amount_paid').eq('status', 'sent').not('due_date', 'is', null).lt('due_date', today),
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('work_orders').select('*', { count: 'exact', head: true }),
  ]);

  const arBalance = (arData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);
  const revenueThisMonth = (revMonthData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const revenueYTD = (revYTDData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const overdueBalance = (overdueBalData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);

  // Activity stream (UNION ALL equivalent — 3 separate queries + JS merge)
  const [woAct, estAct, invAct] = await Promise.all([
    supabase.from('work_orders').select(WO_DASHBOARD_SELECT).order('created_at', { ascending: false }).limit(10),
    supabase.from('estimates').select(EST_DASHBOARD_SELECT).order('created_at', { ascending: false }).limit(10),
    supabase.from('invoices').select(INV_DASHBOARD_SELECT).order('created_at', { ascending: false }).limit(10),
  ]);

  const activity = [
    ...(woAct.data || []).map(r => ({
      type: 'work_order', id: r.id, number: 'WO-' + r.display_number,
      status: r.status, created_at: r.created_at, total: null,
      ...displayForWorkOrder(r),
    })),
    ...(estAct.data || []).map(r => ({
      type: 'estimate', id: r.id, number: 'EST-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      ...displayForNestedWorkOrder(r),
    })),
    ...(invAct.data || []).map(r => ({
      type: 'invoice', id: r.id, number: 'INV-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      ...displayForNestedWorkOrder(r),
    })),
  ].sort((a, b) => b.created_at?.localeCompare(a.created_at || '') || 0).slice(0, 10);

  res.render('dashboard/index', {
    title: 'Dashboard',
    activeNav: 'dashboard',
    openEstimates: openEstimates || 0, scheduledWOs: scheduledWOs || 0,
    unpaidInvoices: unpaidInvoices || 0, arBalance,
    revenueThisMonth, revenueYTD,
    overdueCount: overdueCount || 0, overdueBalance,
    activity, customerCount: customerCount || 0, workOrderCount: workOrderCount || 0,
  });
});

// =============================================================================
// "/" — the modern operational dashboard (today-focused schedule list,
// asymmetric action queues, denser typography, flat right-rail action queue).
// The earlier KPI-card dashboard is at /dashboard-classic.
// =============================================================================
router.get('/', async (req, res) => {
  if (req.session?.role === 'worker') return res.redirect('/work-orders');

  // D-059 A4: default_landing redirect — if user prefers chat, send to /forge
  if (res.locals.currentUser && res.locals.currentUser.default_landing === 'chat') {
    return res.redirect('/forge');
  }

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);

  // ---------- Timeline: today's activity feed ----------
  const userId = req.session?.userId || null;
  const userRole = await (async () => {
    const { data: u } = await checkedDashboardRead(
      supabase.from('users').select('role').eq('id', userId).maybeSingle(),
      'dashboard user role read failed',
    );
    return u ? u.role : 'admin';
  })();
  const dayTimeline = await timeline.buildDayTimeline({ date: today, userId, workerOnly: userRole === 'worker' });

  // ---------- Schedule: tomorrow preview ----------
  const { data: tomorrowWOs } = await checkedDashboardRead(supabase
    .from('work_orders')
    .select('id, display_number, scheduled_time, customer_id, customers!left(name), jobs!left(title, customers!left(name)), assigned_to_user_id, users!left(name), work_order_assignees(users!work_order_assignees_user_id_fkey(id, name)))')
    .eq('scheduled_date', tomorrow)
    .in('status', ['scheduled', 'in_progress'])
    .order('scheduled_time', { ascending: true, nullsFirst: false }), 'dashboard tomorrow work orders read failed');

  const tomorrowMapped = (tomorrowWOs || []).map(r => ({
    id: r.id, display_number: r.display_number, scheduled_time: r.scheduled_time,
    ...displayForWorkOrder(r),
    user_name: r.users?.name, assigned_to: r.assigned_to_user_id,
  }));
  const tomorrowCount = tomorrowMapped.length;
  const tomorrowPreview = tomorrowMapped.slice(0, 3);

  // ---------- Schedule: this week (peek) ----------
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { count: upcomingThisWeek } = await checkedDashboardRead(supabase
    .from('work_orders')
    .select('*', { count: 'exact', head: true })
    .gte('scheduled_date', tomorrow)
    .lte('scheduled_date', weekEnd)
    .in('status', ['scheduled', 'in_progress']), 'dashboard upcoming work orders count failed');

  // ---------- Action queues ----------
  // 1. Estimates ready to send
  const [estimatesToSendResult, estimatesToSendCountResult] = await Promise.all([
    supabase.from('estimates')
      .select('id, total, created_at, work_orders!left(display_number, customer_id, customers!left(name), jobs!left(title, customers!left(name)))')
      .eq('status', 'draft').order('created_at', { ascending: false }).limit(5),
    supabase.from('estimates').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
  ]);
  const { data: estimatesToSend } = assertDashboardRead(estimatesToSendResult, 'dashboard draft estimates read failed');
  const { count: estimatesToSendCount } = assertDashboardRead(estimatesToSendCountResult, 'dashboard draft estimates count failed');
  const estMapped = (estimatesToSend || []).map(r => ({
    id: r.id, display_number: r.work_orders?.display_number,
    total: r.total, customer_name: displayForNestedWorkOrder(r).customer_name, created_at: r.created_at,
  }));

  // 2. Invoices overdue
  const [overdueInvoicesResult, overdueInvoicesCountResult, overdueSumResult] = await Promise.all([
    supabase.from('invoices')
      .select('id, total, amount_paid, due_date, work_orders!left(display_number, customer_id, customers!left(name), jobs!left(title, customers!left(name)))')
      .in('status', ['sent', 'overdue']).not('due_date', 'is', null).lt('due_date', today)
      .order('due_date', { ascending: true }).limit(5),
    supabase.from('invoices').select('*', { count: 'exact', head: true })
      .in('status', ['sent', 'overdue']).not('due_date', 'is', null).lt('due_date', today),
    supabase.from('invoices').select('total, amount_paid')
      .in('status', ['sent', 'overdue']).not('due_date', 'is', null).lt('due_date', today),
  ]);
  const { data: overdueInvoices } = assertDashboardRead(overdueInvoicesResult, 'dashboard overdue invoices read failed');
  const { count: overdueInvoicesCount } = assertDashboardRead(overdueInvoicesCountResult, 'dashboard overdue invoices count failed');
  const { data: overdueSumData } = assertDashboardRead(overdueSumResult, 'dashboard overdue invoices sum read failed');
  const invMapped = (overdueInvoices || []).map(r => ({
    id: r.id, display_number: r.work_orders?.display_number,
    total: r.total, amount_paid: r.amount_paid, due_date: r.due_date,
    customer_name: displayForNestedWorkOrder(r).customer_name,
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
  const { data: staleEstimates } = await checkedDashboardRead(supabase
    .from('estimates')
    .select('id, total, sent_at, work_orders!left(display_number, customer_id, customers!left(name), jobs!left(title, customers!left(name)))')
    .eq('status', 'sent').not('sent_at', 'is', null).lt('sent_at', weekAgo)
    .order('sent_at', { ascending: true }).limit(5), 'dashboard stale estimates read failed');
  const staleMapped = (staleEstimates || []).map(r => ({
    id: r.id, display_number: r.work_orders?.display_number,
    total: r.total, customer_name: displayForNestedWorkOrder(r).customer_name,
    sent_at: r.sent_at,
    days_since_sent: Math.floor((Date.now() - new Date(r.sent_at).getTime()) / 86400000),
  }));
  const staleEstimatesCount = staleMapped.length;

  // ---------- Activity stream ----------
  const todayWoIds = dayTimeline.map(d => d.wo_id).filter(Boolean);
  const limitRecords = 12;

  const [woActResult, estActResult, invActResult] = await Promise.all([
    supabase.from('work_orders')
      .select(WO_DASHBOARD_SELECT)
      .order('created_at', { ascending: false }).limit(limitRecords),
    supabase.from('estimates')
      .select(EST_DASHBOARD_SELECT)
      .order('created_at', { ascending: false }).limit(limitRecords),
    supabase.from('invoices')
      .select(INV_DASHBOARD_SELECT)
      .order('created_at', { ascending: false }).limit(limitRecords),
  ]);
  const woAct = assertDashboardRead(woActResult, 'dashboard work order activity read failed');
  const estAct = assertDashboardRead(estActResult, 'dashboard estimate activity read failed');
  const invAct = assertDashboardRead(invActResult, 'dashboard invoice activity read failed');

  let activity = [
    ...(woAct.data || []).filter(r => !todayWoIds.includes(r.id)).map(r => ({
      type: 'work_order', id: r.id, number: 'WO-' + r.display_number,
      status: r.status, created_at: r.created_at, total: null,
      ...displayForWorkOrder(r),
    })),
    ...(estAct.data || []).map(r => ({
      type: 'estimate', id: r.id, number: 'EST-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      ...displayForNestedWorkOrder(r),
    })),
    ...(invAct.data || []).map(r => ({
      type: 'invoice', id: r.id, number: 'INV-' + r.work_orders?.display_number,
      status: r.status, created_at: r.created_at, total: r.total,
      ...displayForNestedWorkOrder(r),
    })),
  ].sort((a, b) => b.created_at?.localeCompare(a.created_at || '') || 0).slice(0, limitRecords);

  // ---------- Bottom metrics ----------
  const [arResult, revMonthResult, revYTDResult, customerCountResult, activeWorkOrdersResult] = await Promise.all([
    supabase.from('invoices').select('total, amount_paid').in('status', ['sent', 'overdue']),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentMonth + '-01'),
    supabase.from('invoices').select('amount_paid').eq('status', 'paid').not('paid_at', 'is', null).gte('paid_at', currentYear + '-01-01'),
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('work_orders').select('id').in('status', ['scheduled', 'in_progress']),
  ]);
  const { data: arData } = assertDashboardRead(arResult, 'dashboard AR balance read failed');
  const { data: revMonthData } = assertDashboardRead(revMonthResult, 'dashboard monthly revenue read failed');
  const { data: revYTDData } = assertDashboardRead(revYTDResult, 'dashboard YTD revenue read failed');
  const { count: customerCount } = assertDashboardRead(customerCountResult, 'dashboard customer count failed');
  const { data: activeWorkOrders } = assertDashboardRead(activeWorkOrdersResult, 'dashboard active work orders read failed');

  const arBalance = (arData || []).reduce((s, r) => s + Number(r.total || 0) - Number(r.amount_paid || 0), 0);
  const revenueThisMonth = (revMonthData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const revenueYTD = (revYTDData || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const workOrdersActive = activeWorkOrders?.length || 0;

  res.render('dashboard/v2', {
    title: 'Dashboard',
    activeNav: 'dashboard',
    inlineAiChat: true,
    today, tomorrow,
    dayTimeline, tomorrowPreview, tomorrowCount, upcomingThisWeek: upcomingThisWeek || 0,
    estimatesToSend: estMapped, estimatesToSendCount: estimatesToSendCount || 0,
    overdueInvoices: invMapped, overdueInvoicesCount: overdueInvoicesCount || 0, overdueTotal,
    billsToApprove: billsMapped, billsToApproveCount, billsToApproveTotal,
    staleEstimates: staleMapped, staleEstimatesCount,
    activity,
    arBalance, revenueThisMonth, revenueYTD, customerCount: customerCount || 0, workOrdersActive,
    serverTime: new Date().toISOString(),
  });
});

// D-059 A1: Chat-first landing page ("Ask FORGE")
router.get('/forge', async (req, res) => {
  res.render('forge/chat', {
    title: 'FORGE AI',
    activeNav: 'forge',
    inlineAiChat: true,
    currentUser: res.locals.currentUser || null,
  });
});

// D-066 Comprehensive tutorial — server-side state machine, split-pane shell
// Replaces D-063 v3 client-side walkthrough
const crypto = require('crypto');
const { TutorialState } = require('../services/tutorial-state');

function isMissingTutorialSessionsTable(error) {
  const message = String(error?.message || '');
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || (/tutorial_sessions/i.test(message) && /does not exist|not find|not found|schema cache/i.test(message));
}

async function assertTutorialWrite(result, label) {
  const { error } = await result;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function cleanupTutorialRecords(state) {
  state.cleanupChosen = 'cleanup';

  // Delete in dependency order: project payments -> invoices -> estimates -> WOs -> customers
  const ids = state.createdEntityIds;
  if (ids.payments.length) await assertTutorialWrite(supabase.from('project_payments').delete().in('id', ids.payments), 'tutorial cleanup project_payments delete failed');
  if (ids.invoices.length) await assertTutorialWrite(supabase.from('invoices').delete().in('id', ids.invoices), 'tutorial cleanup invoices delete failed');
  if (ids.estimates.length) await assertTutorialWrite(supabase.from('estimates').delete().in('id', ids.estimates), 'tutorial cleanup estimates delete failed');
  if (ids.work_orders.length) await assertTutorialWrite(supabase.from('work_orders').delete().in('id', ids.work_orders), 'tutorial cleanup work_orders delete failed');
  if (ids.customers.length) await assertTutorialWrite(supabase.from('customers').delete().in('id', ids.customers), 'tutorial cleanup customers delete failed');

  await assertTutorialWrite(supabase.from('users').update({ completed_tutorial_at: new Date().toISOString() }).eq('id', state.userId), 'tutorial cleanup completion update failed');
}

async function keepTutorialRecords(state) {
  state.cleanupChosen = 'keep';

  const tutorialEntityTables = [
    ['project_payments', 'payments'],
    ['invoices', 'invoices'],
    ['estimates', 'estimates'],
    ['work_orders', 'work_orders'],
    ['customers', 'customers'],
  ];
  for (const [table, key] of tutorialEntityTables) {
    const ids = state.createdEntityIds[key];
    if (ids.length) {
      await assertTutorialWrite(supabase.from(table).update({ tutorial_session_id: null }).in('id', ids), `tutorial keep ${table} update failed`);
    }
  }

  await assertTutorialWrite(supabase.from('users').update({ completed_tutorial_at: new Date().toISOString() }).eq('id', state.userId), 'tutorial keep completion update failed');
}

async function executeTutorialStepEffects(step, state) {
  if (!step) return;

  state.recordStepAnswer(step.record_answer);

  for (const effect of step.side_effects || []) {
    if (effect.call_endpoint === 'POST /forge/tutorial/cleanup') {
      await cleanupTutorialRecords(state);
    } else if (effect.call_endpoint === 'POST /forge/tutorial/keep') {
      await keepTutorialRecords(state);
    } else {
      await state.executeSideEffects([effect], supabase, state.userId);
    }
  }
}

async function resolveTutorialSessionId(req, userId) {
  if (req.session?.tutorialSessionId) return req.session.tutorialSessionId;
  if (userId) {
    try {
      const { data, error } = await supabase
        .from('tutorial_sessions')
        .select('id,state_json')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data?.id && !data.state_json?.cleanupChosen) {
        if (req.session) req.session.tutorialSessionId = data.id;
        return data.id;
      }
    } catch (e) {
      if (!isMissingTutorialSessionsTable(e)) throw e;
    }
  }
  const sessionId = crypto.randomUUID();
  if (req.session) req.session.tutorialSessionId = sessionId;
  return sessionId;
}

router.get('/forge/tutorial', async (req, res) => {
  const { loadChapters, totalChapters } = require('../services/tutorial-content');
  loadChapters();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const sessionId = await resolveTutorialSessionId(req, res.locals.currentUser?.id);

  const state = await TutorialState.load(sessionId, res.locals.currentUser?.id, supabase, req.session);
  await state.save(supabase, req.session);
  const currentChapter = state.getCurrentChapter();
  const currentStep = state.getCurrentStep();
  const tc = require('../services/tutorial-content');
  if (currentChapter?.narration) {
    currentChapter.narration = tc.interpolateNarration(currentChapter.narration, res.locals.currentUser);
  }
  if (currentStep?.coach_text) {
    currentStep.coach_text = tc.interpolateNarration(currentStep.coach_text, res.locals.currentUser);
  }

  res.render('forge/tutorial', {
    title: 'FORGE Tutorial',
    activeNav: 'forge',
    currentUser: res.locals.currentUser || null,
    returnTo: req.query.return || '/forge',
    tutorialSessionId: sessionId,
    currentChapter,
    currentStep,
    chapterIndex: state.currentChapter,
    totalChapters: totalChapters(),
    stepIndex: state.currentStep,
    tutorialContentVersion: tc.contentVersion(),
  });
});

// Tutorial state API
router.get('/forge/tutorial/state', async (req, res) => {
  const sessionId = req.session?.tutorialSessionId;
  if (!sessionId) return res.status(404).json({ error: 'No active tutorial' });
  res.set('Cache-Control', 'no-store');
  const { loadChapters } = require('../services/tutorial-content');
  loadChapters();
  const state = await TutorialState.load(sessionId, res.locals.currentUser?.id, supabase, req.session);
  const ch = state.getCurrentChapter();
  const tc = require('../services/tutorial-content');
  res.json({
    chapterIndex: state.currentChapter,
    stepIndex: state.currentStep,
    completedChapters: state.completedChapters,
    quizSubmitted: state.quizSubmitted,
    chapter: ch ? {
      ...ch,
      narration: ch.narration ? tc.interpolateNarration(ch.narration, res.locals.currentUser) : ch.narration,
    } : null,
    totalChapters: tc.totalChapters(),
    tutorialContentVersion: tc.contentVersion(),
  });
});

router.post('/forge/tutorial/advance', async (req, res) => {
  const sessionId = req.session?.tutorialSessionId;
  if (!sessionId) return res.status(404).json({ error: 'No active tutorial' });
  res.set('Cache-Control', 'no-store');

  // Ensure chapters are loaded (serverless instances may not share state)
  const { loadChapters } = require('../services/tutorial-content');
  loadChapters();

  const state = await TutorialState.load(sessionId, res.locals.currentUser?.id, supabase, req.session);
  const { action, payload } = req.body;

  const currentStep = state.getCurrentStep();
  try {
    await executeTutorialStepEffects(currentStep, state);
  } catch (e) {
    console.error('[tutorial] step side effect failed:', e.message);
    return res.status(500).json({ error: 'Tutorial action failed. Please try again.' });
  }

  const result = state.processAction(action, payload, supabase);

  // Handle EXIT_TUTORIAL
  if (result.exit) {
    await state.save(supabase, req.session);
    if (state.cleanupChosen && req.session) delete req.session.tutorialSessionId;
    return res.json({ redirect: req.query.return || '/forge' });
  }

  // Log any errors returned by the state machine
  if (result.error) {
    console.error('[tutorial] state error:', result.error, 'action:', action);
  }

  await state.save(supabase, req.session);

  // Inject chapterIndex + totalChapters into response for progress tracking
  const tc = require('../services/tutorial-content');
  result.chapterIndex = state.currentChapter;
  result.totalChapters = tc.totalChapters();
  result.tutorialContentVersion = tc.contentVersion();

  // Interpolate narration with user info
  const interpolated = require('../services/tutorial-content').interpolateNarration;
  if (result.chapter && result.chapter.narration) {
    result.chapter.narration = interpolated(result.chapter.narration, res.locals.currentUser);
  }
  const step = result.chapter?.steps?.[result.step || 0];
  if (step?.coach_text) {
    step.coach_text = interpolated(step.coach_text, res.locals.currentUser);
  }

  res.json(result);
});

router.post('/forge/tutorial/cleanup', async (req, res) => {
  const sessionId = req.session?.tutorialSessionId;
  if (!sessionId) return res.status(404).json({ error: 'No active tutorial' });

  const { loadChapters } = require('../services/tutorial-content');
  loadChapters();
  const state = await TutorialState.load(sessionId, res.locals.currentUser?.id, supabase, req.session);
  await cleanupTutorialRecords(state);
  await state.save(supabase, req.session);
  if (req.session) delete req.session.tutorialSessionId;

  res.json({ message: 'All tutorial data cleared. You\'re starting fresh.' });
});

router.post('/forge/tutorial/keep', async (req, res) => {
  const sessionId = req.session?.tutorialSessionId;
  if (!sessionId) return res.status(404).json({ error: 'No active tutorial' });

  const { loadChapters } = require('../services/tutorial-content');
  loadChapters();
  const state = await TutorialState.load(sessionId, res.locals.currentUser?.id, supabase, req.session);
  await keepTutorialRecords(state);
  await state.save(supabase, req.session);
  if (req.session) delete req.session.tutorialSessionId;

  res.json({ message: 'Kept your tutorial records. Find them in your Customers list.' });
});

module.exports = router;
