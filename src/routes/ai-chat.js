/**
 * ai-chat.js — Route for AI chat assistant.
 *
 * POST /ai/chat   — process a chat message
 * GET  /ai/chat/health — check if AI chat is enabled
 */
const express = require('express');
const router = express.Router();
const chatService = require('../services/ai-chat');
const rateLimit = require('express-rate-limit');

// Rate limiter: 30 calls per 5 min per user
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
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
      const u = (() => { try { return require('../db/db').get('SELECT name, role FROM users WHERE id = ?', [userId]); } catch(e){} })();
      if (u) { userName = u.name; role = u.role; }
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
      audit_id: result.audit_id
    });
  } catch (err) {
    console.error('[ai-chat] error:', err);
    res.status(500).json({ error: 'Internal error processing chat request.' });
  }
});

module.exports = router;
