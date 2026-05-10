/**
 * AI service — provider-agnostic wrapper around DeepSeek / OpenAI / Anthropic
 * for Round 8+ assistant features.
 *
 * Stub state (this commit): wired but does NOT call real APIs yet. Returns
 * `null` if AI_API_KEY is missing. Round 8 swaps the bodies of `extract()` and
 * `suggest()` for real fetch() calls and JSON parsing.
 *
 * Public API:
 *   isConfigured()                                          -> boolean
 *   extract({ text, schemaHint, taskName, userId })         -> { ok, data, raw, tokens } | { ok: false, reason }
 *   suggest({ prompt, context, taskName, userId })          -> { ok, text, tokens } | { ok: false, reason }
 *
 * Both call sites must:
 *   1. Audit the call (writeAudit with source='ai' + reason=taskName).
 *   2. Land the AI output in a *suggestion* surface (form pre-fill, ai_extractions
 *      row, etc.) — never auto-commit financial state.
 *
 * Provider routing:
 *   AI_PROVIDER=deepseek  -> https://api.deepseek.com/v1/chat/completions
 *   AI_PROVIDER=openai    -> https://api.openai.com/v1/chat/completions
 *   AI_PROVIDER=anthropic -> https://api.anthropic.com/v1/messages
 */

const { writeAudit } = require('./audit');

function provider() {
  return (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
}

function apiKey() {
  return process.env.AI_API_KEY || '';
}

function isConfigured() {
  return !!apiKey();
}

function logCall({ taskName, userId, ok, tokens, reason }) {
  writeAudit({
    entityType: 'ai_call',
    entityId: 0,
    action: 'invoke',
    before: null,
    after: { provider: provider(), task: taskName, ok, tokens: tokens || null, reason: reason || null },
    source: 'ai',
    userId: userId || null,
    reason: taskName,
  });
}

/**
 * Extract structured data from text (e.g., a vendor receipt).
 * Round 8: posts to chat-completions with response_format=json_object.
 * Stub: returns ok=false with a clear reason.
 */
async function extract({ text, schemaHint, taskName, userId }) {
  if (!isConfigured()) {
    logCall({ taskName, userId, ok: false, reason: 'no_api_key' });
    return { ok: false, reason: 'AI_API_KEY not configured. Set it in .env to enable extraction.' };
  }
  // Stub: not wired yet. Round 8 implements.
  logCall({ taskName, userId, ok: false, reason: 'stub_not_wired' });
  return { ok: false, reason: 'AI extraction not wired yet (Round 8).' };
}

/**
 * Generate a free-form suggestion (e.g., clean up tech notes,
 * write an invoice description).
 */
async function suggest({ prompt, context, taskName, userId }) {
  if (!isConfigured()) {
    logCall({ taskName, userId, ok: false, reason: 'no_api_key' });
    return { ok: false, reason: 'AI_API_KEY not configured. Set it in .env to enable suggestions.' };
  }
  logCall({ taskName, userId, ok: false, reason: 'stub_not_wired' });
  return { ok: false, reason: 'AI suggestions not wired yet (Round 8).' };
}

module.exports = { isConfigured, extract, suggest, provider };
