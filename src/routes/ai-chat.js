/**
 * ai-chat.js — Route for AI chat assistant.
 *
 * POST /ai/chat   — process a chat message
 * GET  /ai/chat/health — check if AI chat is enabled
 */
const express = require('express');
const router = express.Router();
const chatService = require('../services/ai-chat');

// Kill switch: AI_CHAT_ENABLED=0 disables the endpoint
const isEnabled = () => {
  const val = process.env.AI_CHAT_ENABLED;
  return val === undefined || val === '' || val === '1' || val === 'true';
};

// Chat endpoint
router.post('/chat', async (req, res) => {
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
      history: Array.isArray(history) ? history.slice(-20) : [],
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
