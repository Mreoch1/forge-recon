const supabase = require('../db/supabase');

async function logAiChatError({ userId, sessionId, userMessage, errorType, errorMessage, errorStack, provider, toolName, requestPayload, responsePayload }) {
  try {
    const validTypes = ['provider_error', 'tool_error', 'timeout', 'rate_limit', 'malformed_response', 'auth', 'unknown'];
    const safeType = validTypes.includes(errorType) ? errorType : 'unknown';
    await supabase.from('ai_chat_errors').insert({
      user_id: userId || null,
      session_id: (sessionId || '').slice(0, 255) || null,
      user_message: (userMessage || '').slice(0, 2000) || null,
      error_type: safeType,
      error_message: (errorMessage || '').slice(0, 2000),
      error_stack: (errorStack || '').slice(0, 5000) || null,
      provider: (provider || '').slice(0, 100) || null,
      tool_name: (toolName || '').slice(0, 100) || null,
      request_payload: requestPayload || null,
      response_payload: responsePayload || null,
    });
  } catch (logErr) {
    console.warn('[ai-chat] failed to log error:', logErr.message);
  }
}

module.exports = { logAiChatError };
