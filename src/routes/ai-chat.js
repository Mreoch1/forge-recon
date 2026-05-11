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
const rateLimit = require('express-rate-limit');

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
        const u = await require('../db/db').get('SELECT name, role FROM users WHERE id = ?', [userId]);
        if (u) { userName = u.name; role = u.role; }
      } catch(e) { /* fall back to defaults */ }
    }
    const ctx = { userId, userName, role };

    const result = await chatService.chat({
      message: message.trim(),
      history: safeHistory,
      ctx
    });

    res.json({
      reply: result.reply,
      chips: result.chips || [],
      tool_calls: result.tool_calls || [],
      confirm: result.confirm || undefined,
      audit_id: result.audit_id
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

  const db = require('../db/db');
  const row = await db.get('SELECT * FROM pending_confirmations WHERE id = ?', [confirmation_id]);

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
    await db.run("UPDATE pending_confirmations SET status = 'expired' WHERE id = ?", [row.id]);
    await writeAudit({ entityType: 'pending_confirmation', entityId: row.id, action: 'expired', before: null, after: { tool: row.tool }, source: 'ai', userId: row.user_id });
    return res.status(409).json({ error: 'Confirmation expired. Please ask the AI again.' });
  }

  if (accept === true || accept === 'true') {
    // Execute the mutation
    const args = JSON.parse(row.args || '{}');
    const userId = req.session?.userId || 0;
    let userName = '';
    let role = 'admin';
    try {
      const userRow = await db.get('SELECT name, role FROM users WHERE id = ?', [userId]);
      if (userRow) { userName = userRow.name || ''; role = userRow.role || 'admin'; }
    } catch (e) { /* fall back to defaults */ }
    const ctx = { userId, userName, role };

    const result = await tools.executeMutation(row.tool, args, ctx);
    if (result.ok) {
      await db.run("UPDATE pending_confirmations SET status = 'confirmed' WHERE id = ?", [row.id]);
      await writeAudit({ entityType: 'pending_confirmation', entityId: row.id, action: 'confirmed', before: null, after: { tool: row.tool, result: result.result }, source: 'ai', userId: row.user_id });

      const chips = result.result && result.result.href
        ? [{ label: `View ${row.tool.replace(/_/g, ' ')}`, href: result.result.href }]
        : [];

      return res.json({ ok: true, result: result.result, chips });
    } else {
      await db.run("UPDATE pending_confirmations SET status = 'failed' WHERE id = ?", [row.id]);
      return res.status(500).json({ ok: false, error: result.error || 'Execution failed.' });
    }
  } else {
    // Cancel
    await db.run("UPDATE pending_confirmations SET status = 'cancelled' WHERE id = ?", [row.id]);
    await writeAudit({ entityType: 'pending_confirmation', entityId: row.id, action: 'cancelled', before: null, after: { tool: row.tool }, source: 'ai', userId: row.user_id });
    return res.json({ ok: true, cancelled: true });
  }
});

module.exports = router;
