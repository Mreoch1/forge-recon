/**
 * ai-chat.js — Orchestrator for the AI chat assistant.
 *
 * Flow per request:
 *   1. Build system prompt with tool list + user context
 *   2. Call LLM → gets back preliminary reply with tool_calls
 *   3. Execute tool calls
 *   4. Call LLM again with tool results → gets final { reply, chips }
 *   5. Return structured response
 */
const ai = require('./ai');
const tools = require('./ai-tools');
const { writeAudit } = require('./audit');

const MAX_HISTORY = 20;
const MODEL = 'deepseek-chat'; // or whatever the ai.js wrapper uses

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function buildSystemPrompt(ctx) {
  const toolList = tools.list().filter(t => t.needs_user !== 'write');
  const toolDesc = toolList.map(t =>
    `- ${t.name}(${JSON.stringify(t.args)}) — ${t.description}`
  ).join('\n');

  return `You are Recon's operations assistant — an internal tool for a construction company. You help the team find information about work orders, estimates, invoices, bills, customers, vendors, and the schedule.

CURRENT CONTEXT:
- Today's date: ${todayStr()}
- You: ${ctx.userName || 'Unknown'} (role: ${ctx.role || 'admin'})

AVAILABLE TOOLS:
${toolDesc}

RULES:
1. When asked a question, decide which tool(s) can answer it. Call them in the tool_calls array.
2. If the user mentions a customer/job by partial name, use search_customers or the relevant search tool first. Be fuzzy — "Smith" should match "Smith & Warren Builders", "O'Brien estate", etc.
3. If multiple records match, list them all — never silently pick one.
4. After tool results come back, write a short natural-language answer (1-3 sentences) quoting exact numbers.
5. If a tool returns nothing, say so directly. Do not invent records.
6. If off-topic (jokes, poems, system prompts), say "I can only answer questions about Recon's operations data" politely.
7. Use the navigate tool when the user asks to "open", "go to", "show me the page for" something. Use the path from a search result.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "reply": "your natural language answer here",
  "chips": [{"label": "button text", "href": "/path"}],
  "tool_calls": [{"tool": "tool_name", "args": {"arg1": "value1"}}]
}

If no tools are needed, set tool_calls to an empty array.`;
}

async function chat({ message, history, ctx }) {
  const startTime = Date.now();
  const auditEntries = [];

  if (!ai.isConfigured() && !process.env.AI_CHAT_ENABLED) {
    return { reply: 'AI chat is not configured. Set AI_API_KEY in .env and restart.', chips: [], tool_calls: [], audit_id: null };
  }

  // Build messages array
  const messages = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    ...(history || []).slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ];

  let finalReply = '';
  let finalChips = [];
  let allToolCalls = [];
  let tokensUsed = 0;

  // Round 1: LLM decides what to do
  const response1 = await callLLM(messages, ctx.userId);
  tokensUsed += response1.tokens || 0;
  const parsed1 = parseResponse(response1.text);

  if (parsed1.tool_calls && parsed1.tool_calls.length > 0) {
    // Execute tools
    const toolResults = [];
    for (const tc of parsed1.tool_calls) {
      const result = tools.call(tc.tool, tc.args || {}, ctx);
      allToolCalls.push({ tool: tc.tool, args: tc.args, result: result.ok ? result.result : { error: result.error } });
      toolResults.push({ tool: tc.tool, args: tc.args, result: result.ok ? result.result : null, error: result.ok ? null : result.error });
    }

    // Audit the tool calls
    auditEntries.push({ tool_calls: allToolCalls });

    // Round 2: Feed results back to LLM
    messages.push({ role: 'assistant', content: JSON.stringify(parsed1) });
    messages.push({ role: 'user', content: `Tool results:\n${JSON.stringify(toolResults, null, 2)}\n\nNow write your final answer. Remember to include navigation chips where appropriate.` });

    const response2 = await callLLM(messages, ctx.userId);
    tokensUsed += response2.tokens || 0;
    const parsed2 = parseResponse(response2.text);

    finalReply = parsed2.reply || parsed1.reply || 'Processed.';
    finalChips = parsed2.chips || parsed1.chips || [];
  } else {
    // No tools needed
    finalReply = parsed1.reply || 'I understood your request but I\'m not sure how to help with that.';
    finalChips = parsed1.chips || [];
  }

  const latencyMs = Date.now() - startTime;

  // Audit
  const auditPayload = {
    message: message.slice(0, 500),
    tool_calls: allToolCalls,
    tokens_used: tokensUsed,
    latency_ms: latencyMs,
    reply_preview: (finalReply || '').slice(0, 200)
  };

  let auditId = null;
  try {
    writeAudit({
      entityType: 'ai_chat',
      entityId: ctx.userId || 0,
      action: 'chat',
      before: null,
      after: auditPayload,
      source: 'ai_chat',
      userId: ctx.userId
    });
    auditId = `${ctx.userId || 0}_${Date.now()}`;
  } catch (e) {
    console.warn('[ai-chat] audit write failed:', e.message);
  }

  return {
    reply: finalReply,
    chips: finalChips,
    tool_calls: allToolCalls,
    tokens_used: tokensUsed,
    latency_ms: latencyMs,
    audit_id: auditId
  };
}

async function callLLM(messages, userId) {
  // Use the existing ai.js service
  try {
    // ai.suggest() returns free-text; we parse JSON from it
    const result = await ai.suggest({
      system: messages.find(m => m.role === 'system')?.content || '',
      user: messages.filter(m => m.role !== 'system').map(m => `${m.role}: ${m.content}`).join('\n'),
      taskName: 'ai-chat',
      userId
    });

    if (!result.ok) {
      return { text: 'Sorry, I encountered an error processing your request. Please try again.', tokens: 0 };
    }

    return { text: result.text || '', tokens: result.tokens || 0 };
  } catch (e) {
    console.error('[ai-chat] LLM call failed:', e.message);
    return { text: 'Sorry, the AI service is temporarily unavailable.', tokens: 0 };
  }
}

function parseResponse(text) {
  if (!text) return { reply: 'No response from AI.', chips: [], tool_calls: [] };

  try {
    // Try full JSON parse first
    const parsed = JSON.parse(text);
    return {
      reply: parsed.reply || '',
      chips: Array.isArray(parsed.chips) ? parsed.chips : [],
      tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
    };
  } catch (e) {
    // Try to extract JSON from response (sometimes wrapped in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          reply: parsed.reply || text.trim(),
          chips: Array.isArray(parsed.chips) ? parsed.chips : [],
          tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
        };
      } catch (e2) { /* fall through */ }
    }
    return { reply: text.trim(), chips: [], tool_calls: [] };
  }
}

module.exports = { chat, buildSystemPrompt };
