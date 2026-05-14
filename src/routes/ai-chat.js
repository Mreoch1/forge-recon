/**
 * ai-chat.js — Route for AI chat assistant.
 *
 * POST /ai/chat   — process a chat message
 * GET  /ai/chat/health — check if AI chat is enabled
 */
const express = require('express');
const router = express.Router();
const chatService = require('../services/ai-chat');
const tools = require('../services/ai-tools');
const { writeAudit } = require('../services/audit');
const { logAiChatError } = require('../services/ai-chat-errors');
const rateLimit = require('express-rate-limit');
const supabase = require('../db/supabase');

// Rate limiter: 30 calls per 5 min per user
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.session?.userId || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: 'Rate limit reached. Try again in a few minutes.' });
  }
});

// Kill switch
const isEnabled = () => {
  const val = process.env.AI_CHAT_ENABLED;
  return val === undefined || val === '' || val === '1' || val === 'true';
};

// Chat endpoint
router.post('/chat', chatLimiter, async (req, res) => {
  if (!isEnabled()) {
    return res.status(404).json({ error: 'AI chat disabled' });
  }

  // 60s timeout for slow LLM responses
  req.setTimeout(60000);

  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long (max 2000 chars).' });
  }

  // Validate history — anti-tampering
  let safeHistory = [];
  if (Array.isArray(history)) {
    safeHistory = history.filter(h => h && typeof h === 'object')
      .map(h => ({
        role: (h.role === 'user' || h.role === 'assistant') ? h.role : 'user',
        content: typeof h.content === 'string' ? h.content.slice(0, 2000) : '',
        chips: Array.isArray(h.chips) ? h.chips.slice(0, 5) : undefined
      }))
      .filter(h => h.content.length > 0)
      .slice(-20);
  }

  try {
    const userId = req.session?.userId || 0;
    // Get user info for context (role check, worker filtering)
    let userName = 'Unknown';
    let role = 'admin';
    if (userId) {
      try {
        const { data: u } = await supabase.from('users').select('name, role').eq('id', userId).maybeSingle();
        if (u) { userName = u.name; role = u.role; }
      } catch(e) { /* fall back to defaults */ }
    }
    const ctx = { userId, userName, role };
    const activeIntent = typeof req.body.active_intent === 'string'
      && tools.list().some((tool) => tool.name === req.body.active_intent)
      ? req.body.active_intent
      : null;

    // D-064: entity hierarchy stack — round-trip through client
    const entityStack = Array.isArray(req.body.entity_stack) ? req.body.entity_stack : [];

    const result = await chatService.chat({
      message: message.trim(),
      history: safeHistory,
      ctx,
      active_intent: activeIntent,
      entity_stack: entityStack
    });

    res.json({
      reply: result.reply,
      chips: result.chips || [],
      tool_calls: result.tool_calls || [],
      confirm: result.confirm || undefined,
      audit_id: result.audit_id,
      active_intent: result.active_intent || null,
      entity_stack: result.entity_stack || undefined
    });
  } catch (err) {
    console.error('[ai-chat] error:', err);
    res.status(500).json({ error: 'Internal error processing chat request.' });
  }
});

// Confirm or cancel a pending mutation
router.post('/chat/confirm', async (req, res) => {
  if (!isEnabled()) {
    return res.status(404).json({ error: 'AI chat disabled' });
  }

  const { confirmation_id, accept } = req.body;
  if (!confirmation_id) {
    return res.status(400).json({ error: 'confirmation_id is required.' });
  }

  const logConfirmError = (err, extra = {}) => logAiChatError({
    userId: req.session?.userId || null,
    sessionId: req.sessionID,
    errorType: 'unknown',
    errorMessage: err && err.message ? err.message : String(err || 'AI confirmation error'),
    errorStack: err && err.stack ? err.stack : null,
    toolName: extra.toolName || null,
    requestPayload: { confirmation_id, accept, ...extra },
  });

  const { data: row, error: rowErr } = await supabase.from('pending_confirmations').select('*').eq('id', confirmation_id).maybeSingle();
  if (rowErr) {
    await logConfirmError(rowErr, { phase: 'load_confirmation' });
    return res.status(500).json({ error: 'Could not load confirmation. Please try again.' });
  }

  if (!row) {
    return res.status(404).json({ error: 'Confirmation not found.' });
  }

  // Ownership check
  if (row.user_id !== req.session?.userId) {
    return res.status(403).json({ error: 'This confirmation belongs to another user.' });
  }

  if (row.status !== 'pending') {
    return res.status(409).json({ error: `Confirmation already ${row.status}.` });
  }

  // Expiry check
  if (new Date(row.expires_at) < new Date()) {
    const { error: expireErr } = await supabase.from('pending_confirmations').update({ status: 'expired' }).eq('id', row.id);
    if (expireErr) {
      await logConfirmError(expireErr, { phase: 'mark_expired', toolName: row.tool });
      return res.status(500).json({ error: 'Could not update confirmation status. Please try again.' });
    }
    await writeAudit({ entityType: 'pending_confirmation', entityId: row.id, action: 'expired', before: null, after: { tool: row.tool }, source: 'ai', userId: row.user_id });
    return res.status(409).json({ error: 'Confirmation expired. Please ask the AI again.' });
  }

  if (accept === true || accept === 'true') {
    // Execute the mutation
    let args = {};
    try {
      args = JSON.parse(row.args || '{}');
    } catch (parseErr) {
      await logConfirmError(parseErr, { phase: 'parse_confirmation_args', toolName: row.tool });
      const { error: failErr } = await supabase.from('pending_confirmations').update({ status: 'failed' }).eq('id', row.id);
      if (failErr) {
        await logConfirmError(failErr, { phase: 'mark_failed_after_parse_error', toolName: row.tool });
      }
      return res.status(500).json({ ok: false, error: 'Confirmation payload is invalid. Please ask FORGE to prepare it again.' });
    }
    const userId = req.session?.userId || 0;
    let userName = '';
    let role = 'admin';
    try {
      const { data: userRow, error: userErr } = await supabase.from('users').select('name, role').eq('id', userId).maybeSingle();
      if (userErr) throw userErr;
      if (userRow) { userName = userRow.name || ''; role = userRow.role || 'admin'; }
    } catch (e) {
      await logConfirmError(e, { phase: 'load_user_context', toolName: row.tool });
    }
    const ctx = { userId, userName, role };

    let result;
    try {
      result = await tools.executeMutation(row.tool, args, ctx);
    } catch (executeErr) {
      await logConfirmError(executeErr, { phase: 'execute_mutation', toolName: row.tool });
      const { error: failErr } = await supabase.from('pending_confirmations').update({ status: 'failed' }).eq('id', row.id);
      if (failErr) {
        await logConfirmError(failErr, { phase: 'mark_failed_after_execute_exception', toolName: row.tool });
      }
      return res.status(500).json({ ok: false, error: 'Execution failed.' });
    }
    if (result.ok) {
      const { error: confirmErr } = await supabase.from('pending_confirmations').update({ status: 'confirmed' }).eq('id', row.id);
      if (confirmErr) {
        await logConfirmError(confirmErr, { phase: 'mark_confirmed', toolName: row.tool });
        return res.status(500).json({ error: 'Action ran, but confirmation status could not be saved.' });
      }
      await writeAudit({ entityType: 'pending_confirmation', entityId: row.id, action: 'confirmed', before: null, after: { tool: row.tool, result: result.result }, source: 'ai', userId: row.user_id });

      const chips = result.result && result.result.href
        ? [{ label: `View ${row.tool.replace(/_/g, ' ')}`, href: result.result.href }]
        : [];

      return res.json({ ok: true, result: result.result, chips });
    } else {
      const { error: failErr } = await supabase.from('pending_confirmations').update({ status: 'failed' }).eq('id', row.id);
      if (failErr) {
        await logConfirmError(failErr, { phase: 'mark_failed', toolName: row.tool, mutation_error: result.error });
      }
      return res.status(500).json({ ok: false, error: result.error || 'Execution failed.' });
    }
  } else {
    // Cancel
    const { error: cancelErr } = await supabase.from('pending_confirmations').update({ status: 'cancelled' }).eq('id', row.id);
    if (cancelErr) {
      await logConfirmError(cancelErr, { phase: 'mark_cancelled', toolName: row.tool });
      return res.status(500).json({ error: 'Could not cancel confirmation. Please try again.' });
    }
    await writeAudit({ entityType: 'pending_confirmation', entityId: row.id, action: 'cancelled', before: null, after: { tool: row.tool }, source: 'ai', userId: row.user_id });
    return res.json({ ok: true, cancelled: true });
  }
});

// AI chat feedback (👍/👎/⚠️ buttons)
router.post('/feedback', (req, res) => {
  const { type, message } = req.body || {};
  const userId = req.session?.userId || null;
  // Fire-and-forget — never block
  supabase.from('ai_chat_errors').insert({
    user_id: userId,
    user_message: (message || '').slice(0, 500),
    error_type: type === 'bug' ? 'unknown' : 'unknown',
    error_message: `User feedback: ${type || 'unknown'} — ${(message || '').slice(0, 200)}`,
    tool_name: 'user_feedback',
  }).then(() => {}).catch(() => {});
  res.json({ ok: true });
});

// D-065: Client-side error reporter — POST from ai-chat.js on 5xx/timeout/invalid response
router.post('/chat-errors', async (req, res) => {
  const { error_type, error_message, user_message, error_stack } = req.body || {};
  const userId = req.session?.userId || null;
  const errType = ['provider_error','tool_error','timeout','rate_limit','malformed_response','auth','unknown'].includes(error_type) ? error_type : 'unknown';
  try {
    // Insert and return the new row ID as the ERR reference.
    const { data, error } = await supabase.from('ai_chat_errors').insert({
      user_id: userId,
      error_type: errType,
      error_message: (error_message || '').slice(0, 2000),
      error_stack: (error_stack || '').slice(0, 5000) || null,
      user_message: (user_message || '').slice(0, 500) || null,
      severity: 'user_reported',
    }).select('id');
    if (error) throw error;
    const errId = data && data[0] ? data[0].id : null;
    res.json({ ok: true, err_id: errId });
  } catch (error) {
    console.warn('[ai-chat] client error report insert failed:', error.message);
    res.json({ ok: false, err_id: null });
  }
});

module.exports = router;
