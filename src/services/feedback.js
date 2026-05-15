/**
 * feedback.js — D-088: user feedback service
 *
 * Handles CRUD for the user_feedback table and provides a unified
 * inbox feed merging user_feedback + ai_chat_errors.
 */

const supabase = require('../db/supabase');

/**
 * Insert a feedback entry submitted via the floating feedback button.
 */
async function submitFeedback({ userId, subject, message, pageUrl, userAgent }) {
  const { data, error } = await supabase
    .from('user_feedback')
    .insert({
      user_id: userId,
      subject,
      message,
      page_url: pageUrl || null,
      user_agent: userAgent || null,
      status: 'new',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Insert an error report from the /report-error endpoint.
 * Writes to ai_chat_errors (which is the canonical error table).
 */
async function submitErrorReport({ userId, errorType, errorMessage, url, userEmail, errorDetail, errorCtx }) {
  const ctx = errorCtx || {};
  const { data, error } = await supabase
    .from('ai_chat_errors')
    .insert({
      user_id: userId,
      error_type: errorType || 'unknown',
      error_message: errorMessage || errorDetail || 'User-reported error',
      tool_name: 'user_reported_error',
      request_payload: { url, user_email: userEmail, ...ctx },
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get the unified inbox feed — merged, sorted newest-first.
 * Returns up to `limit` items total.
 */
async function getInboxFeed(limit = 50, statusFilter) {
  const results = [];

  // 1. Fetch user_feedback
  let fbQuery = supabase
    .from('user_feedback')
    .select('id, subject, message, page_url, user_agent, status, created_at, user_id')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (statusFilter) {
    fbQuery = fbQuery.eq('status', statusFilter);
  }

  const { data: feedback, error: fbError } = await fbQuery;
  if (fbError) throw fbError;
  if (feedback) {
    feedback.forEach(f => {
      results.push({
        id: `fb-${f.id}`,
        source: 'user_feedback',
        sourceId: f.id,
        title: f.subject,
        body: f.message,
        pageUrl: f.page_url,
        userAgent: f.user_agent,
        status: f.status,
        userId: f.user_id,
        createdAt: f.created_at,
      });
    });
  }

  // 2. Fetch ai_chat_errors (only unresolved, skip user_feedback tool_name)
  let errQuery = supabase
    .from('ai_chat_errors')
    .select('id, error_type, error_message, tool_name, created_at, user_id, resolved_at, request_payload')
    .neq('tool_name', 'user_feedback')
    .order('created_at', { ascending: false })
    .limit(limit);

  const { data: errors, error: errError } = await errQuery;
  if (errError) throw errError;
  if (errors) {
    errors.forEach(e => {
      const isResolved = !!e.resolved_at;
      const reqPayload = e.request_payload || {};
      results.push({
        id: `err-${e.id}`,
        source: 'ai_chat_errors',
        sourceId: e.id,
        title: `[${e.error_type}] ${e.tool_name || 'unknown'}`,
        body: e.error_message,
        pageUrl: null,
        userAgent: null,
        status: isResolved ? 'fixed' : 'new',
        userId: e.user_id,
        createdAt: e.created_at,
        requestPayload: reqPayload,
      });
    });
  }

  // Sort newest-first
  results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return results.slice(0, limit);
}

/**
 * Update the status of a feedback item (acker / resolved / etc).
 */
async function updateStatus(source, sourceId, newStatus, resolvedById) {
  if (source === 'user_feedback') {
    const update = { status: newStatus };
    if (newStatus === 'fixed' || newStatus === 'wontfix') {
      update.resolved_at = new Date().toISOString();
      update.resolved_by = resolvedById;
    }
    const { error } = await supabase
      .from('user_feedback')
      .update(update)
      .eq('id', sourceId);
    if (error) throw error;
  }
  // ai_chat_errors are resolved via the existing /admin/ai-errors/:id/resolve route
}

module.exports = {
  submitFeedback,
  submitErrorReport,
  getInboxFeed,
  updateStatus,
};
