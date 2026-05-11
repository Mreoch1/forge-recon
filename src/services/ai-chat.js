/**
 * ai-chat.js — Orchestrator for the AI chat assistant (Tier 1+2+3).
 *
 * Flow per request:
 *   1. Build system prompt with tool list + user context
 *   2. Call LLM → gets back preliminary reply with tool_calls
 *   3. For read/navigate tools: execute → 2nd LLM call → final reply
 *   4. For write tools: create pending confirmation → return confirm payload
 *   5. Return structured response
 */
const ai = require('./ai');
const tools = require('./ai-tools');
const { writeAudit } = require('./audit');
const db = require('../db/db');

const MAX_HISTORY = 20;

const FALSE_PROMISE_PATTERNS = [
  /let me (check|look|search|find|see)/i,
  /one moment/i,
  /hold on/i,
  /i('ll| will) (check|look up|search|find|see)/i,
  /(checking|searching|looking|fetching) (now|that|for you)/i,
];

function hasFalsePromise(reply) {
  return FALSE_PROMISE_PATTERNS.some(function(re) { return re.test(reply || ''); });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function buildSystemPrompt(ctx) {
  const toolList = tools.list().filter(t => t.needs_user !== 'write');
  const toolDesc = toolList.map(t =>
    `- ${t.name}(${JSON.stringify(t.args)}) — ${t.description}`
  ).join('\n');

  // Add mutation tools separately — LLM sees these but knows they require confirmation
  const mutationTools = tools.list().filter(t => t.needs_user === 'write');
  const mutationDesc = mutationTools.map(t =>
    `- ${t.name}(${JSON.stringify(t.args)}) — ${t.description}`
  ).join('\n');

  return `You are Recon's operations assistant — an internal tool for a construction company. You help the team find information about work orders, estimates, invoices, bills, customers, vendors, and the schedule.

CURRENT CONTEXT:
- Today's date: ${todayStr()}
- You: ${ctx.userName || 'Unknown'} (role: ${ctx.role || 'admin'})

AVAILABLE TOOLS:
${toolDesc}

${mutationDesc ? `ACTIONS YOU CAN PROPOSE — ALWAYS use these when the user explicitly asks:
${mutationDesc}
When the user says "add", "create", "send", "mark paid", "approve", or similar action words, you MUST include the matching tool + args in your tool_calls array. The system will ask the user to confirm before executing.

EXAMPLES:
- User: "add a customer named X" → tool_calls: [{"tool":"create_customer", "args":{"name":"X",...}}]
- User: "send estimate 5" → tool_calls: [{"tool":"send_estimate", "args":{"estimate_id":5}}]
- User: "mark INV-5 paid" → tool_calls: [{"tool":"mark_invoice_paid", "args":{"invoice_id":5}}]
- User: "approve bill 3" → tool_calls: [{"tool":"approve_bill", "args":{"bill_id":3}}]
- User: "add a note to WO 7 saying done" → tool_calls: [{"tool":"add_wo_note", "args":{"wo_id":7,"body":"done"}}]

IMPORTANT: Always search for the entity ID first, then include the action tool in the SAME tool_calls array.` : ''}

RULES:
1. When asked a question, decide which tool(s) can answer it. Call them in the tool_calls array.
2. If the user mentions a customer/job by partial name, use search_customers or the relevant search tool first.
3. If multiple records match, list them all — never silently pick one.
4. After tool results come back, write a short natural-language answer (1-3 sentences).
5. If a tool returns nothing, say so directly. Do not invent records.
6. If off-topic, say "I can only answer questions about Recon's operations data" politely.
7. Use the navigate tool when the user asks to "open", "go to", "show me the page for" something.
8. For mutation requests (add/change/send/mark/approve anything), include the relevant search tool call FIRST to find the entity ID, then the orchestrator will handle the confirmation.

Respond ONLY with a JSON object:
{
  "reply": "your natural language answer here",
  "chips": [{"label": "button text", "href": "/path"}],
  "tool_calls": [{"tool": "tool_name", "args": {"arg1": "value1"}}]
}`;
}

async function chat({ message, history, ctx }) {
  const startTime = Date.now();

  if (!ai.isConfigured() && !process.env.AI_CHAT_ENABLED) {
    return { reply: 'AI chat is not configured.', chips: [], tool_calls: [], audit_id: null };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    ...(history || []).slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ];

  let finalReply = '';
  let finalChips = [];
  let allToolCalls = [];
  let tokensUsed = 0;
  let confirmPayload = null;

  // Pre-chat: check for mutation intent via keyword matching (more reliable than LLM)
  const mutationIntent = detectMutationIntent(message, ctx);
  if (mutationIntent) {
    allToolCalls.push({ tool: mutationIntent.tool, args: mutationIntent.args });

    const proposeResult = await tools.propose(mutationIntent.tool, mutationIntent.args, ctx);
    if (proposeResult.error) {
      return {
        reply: proposeResult.error,
        chips: [], tool_calls: allToolCalls, tokens_used: 0,
        latency_ms: Date.now() - startTime, confirm: null,
        audit_id: `${ctx.userId || 0}_${Date.now()}`
      };
    }

    // Disambiguation: multiple name matches → show chips
    if (proposeResult.suggest_disambiguation) {
      const chips = (proposeResult.matches || []).map(m => ({
        label: `${m.name} (${m.email})`,
        action: 'assign_wo',
        // Re-run with specific user_id
        meta: { wo_id: mutationIntent.args.wo_id, assignee_user_id: m.id }
      }));
      return {
        reply: `Multiple users match. Which one did you mean?`,
        chips, tool_calls: allToolCalls, tokens_used: 0,
        latency_ms: Date.now() - startTime, confirm: null,
        audit_id: `${ctx.userId || 0}_${Date.now()}`
      };
    }

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const r = await db.run(`INSERT INTO pending_confirmations (user_id, tool, args, summary, created_at, expires_at)
      VALUES (?, ?, ?, ?, now(), ?)`,
      [ctx.userId, mutationIntent.tool, JSON.stringify(proposeResult.args_normalized || mutationIntent.args),
       JSON.stringify(proposeResult.summary_lines), expiresAt]);

    return {
      reply: proposeResult.summary_lines.length > 0
        ? `I'll prepare to ${mutationIntent.tool.replace(/_/g, ' ')} with these details:`
        : `I'll prepare to ${mutationIntent.tool.replace(/_/g, ' ')}.`,
      chips: [],
      tool_calls: allToolCalls,
      tokens_used: 0,
      latency_ms: Date.now() - startTime,
      confirm: {
        confirmation_id: r.lastInsertRowid,
        tool: mutationIntent.tool,
        summary_lines: proposeResult.summary_lines,
        warnings: proposeResult.warnings || [],
        expires_in_seconds: 300
      },
      audit_id: `${ctx.userId || 0}_${Date.now()}`
    };
  }

  // Round 1: LLM decides what to do
  const response1 = await callLLM(messages, ctx.userId);
  tokensUsed += response1.tokens || 0;
  const parsed1 = parseResponse(response1.text);

  if (parsed1.tool_calls && parsed1.tool_calls.length > 0) {
    // Check if any tool call is a write/mutation tool
    const mutationCalls = parsed1.tool_calls.filter((tc) => {
      const toolInfo = tools.list().find(t => t.name === tc.tool);
      return toolInfo && toolInfo.needs_user === 'write';
    });

    if (mutationCalls.length > 0) {
      // Handle mutation — create pending confirmation
      // (only process the first mutation call per request)
      const mc = mutationCalls[0];
      allToolCalls.push({ tool: mc.tool, args: mc.args });

      // Validate via propose function
      const proposeResult = await tools.propose(mc.tool, mc.args || {}, ctx);
      if (proposeResult.error) {
        finalReply = proposeResult.error;
        // The reply should guide the user
        if (proposeResult.error.includes('not found')) {
          finalReply = `I couldn't find that. Could you provide more details?`;
        }
      } else if (proposeResult.suggest_disambiguation) {
        // Multiple name matches — return chips
        const chips = (proposeResult.matches || []).map(m => ({
          label: `${m.name} (${m.email})`,
          action: 'assign_wo',
          meta: { wo_id: mc.args.wo_id, assignee_user_id: m.id }
        }));
        finalReply = `Multiple users match. Which one did you mean?`;
        finalChips = chips;
      } else {
        // Create pending confirmation
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const r = await db.run(`INSERT INTO pending_confirmations (user_id, tool, args, summary, created_at, expires_at)
          VALUES (?, ?, ?, ?, now(), ?)`,
          [ctx.userId, mc.tool, JSON.stringify(proposeResult.args_normalized || mc.args),
           JSON.stringify(proposeResult.summary_lines), expiresAt]);
        const confirmationId = r.lastInsertRowid;

        confirmPayload = {
          confirmation_id: confirmationId,
          tool: mc.tool,
          summary_lines: proposeResult.summary_lines,
          warnings: proposeResult.warnings || [],
          expires_in_seconds: 300
        };
        finalReply = proposeResult.summary_lines.length > 0
          ? `I'll prepare to ${mc.tool.replace(/_/g, ' ')} with these details:`
          : `I'll prepare to ${mc.tool.replace(/_/g, ' ')}.`;
      }
    } else {
      // All read/navigate tools — execute normally
      const toolResults = [];
      for (const tc of parsed1.tool_calls) {
        const result = await tools.call(tc.tool, tc.args || {}, ctx);
        allToolCalls.push({ tool: tc.tool, args: tc.args, result: result.ok ? result.result : { error: result.error } });
        toolResults.push({ tool: tc.tool, args: tc.args, result: result.ok ? result.result : null, error: result.ok ? null : result.error });
      }

      // Round 2: Feed results back to LLM
      messages.push({ role: 'assistant', content: JSON.stringify(parsed1) });
      messages.push({ role: 'user', content: `Tool results:\n${JSON.stringify(toolResults, null, 2)}\n\nNow write your final answer. Remember to include navigation chips where appropriate.` });

      const response2 = await callLLM(messages, ctx.userId);
      tokensUsed += response2.tokens || 0;
      const parsed2 = parseResponse(response2.text);

      finalReply = parsed2.reply || parsed1.reply || 'Processed.';
      finalChips = parsed2.chips || parsed1.chips || [];
    }
  } else {
    // Auto-chain: detect false promises and re-feed LLM
    let chainCount = 0;
    let currentReply2 = parsed1.reply || '';
    let currentToolCalls = parsed1.tool_calls || [];
    while (chainCount < 3 && hasFalsePromise(currentReply2) && currentToolCalls.length === 0) {
      messages.push({ role: 'assistant', content: JSON.stringify({ reply: currentReply2, tool_calls: currentToolCalls, chips: parsed1.chips || [] }) });
      messages.push({ role: 'user', content: 'You said you would check. Please call the appropriate tool NOW and give me the actual data, not another promise.' });
      const chainResp = await callLLM(messages, ctx.userId);
      tokensUsed += chainResp.tokens || 0;
      const chainParsed = parseResponse(chainResp.text);
      currentReply2 = chainParsed.reply || currentReply2;
      currentToolCalls = chainParsed.tool_calls || [];
      if (currentToolCalls.length > 0) break;
      chainCount++;
    }
    if (currentToolCalls.length > 0) {
      // Execute tools from auto-chain
      const toolResults2 = [];
      for (const tc of currentToolCalls) {
        const result = await tools.call(tc.tool, tc.args || {}, ctx);
        allToolCalls.push({ tool: tc.tool, args: tc.args, result: result.ok ? result.result : { error: result.error } });
        toolResults2.push({ tool: tc.tool, args: tc.args, result: result.ok ? result.result : null, error: result.ok ? null : result.error });
      }
      messages.push({ role: 'assistant', content: JSON.stringify({ reply: currentReply2, tool_calls: currentToolCalls }) });
      messages.push({ role: 'user', content: 'Tool results:\n' + JSON.stringify(toolResults2, null, 2) + '\n\nNow write your final answer. Remember to include navigation chips where appropriate.' });
      const chainResp2 = await callLLM(messages, ctx.userId);
      tokensUsed += chainResp2.tokens || 0;
      const chainParsed2 = parseResponse(chainResp2.text);
      finalReply = chainParsed2.reply || currentReply2;
      finalChips = chainParsed2.chips || [];
    } else {
      finalReply = currentReply2;
      finalChips = parsed1.chips || [];
    }
  }

  const latencyMs = Date.now() - startTime;

  // Audit
  await writeAudit({
    entityType: 'ai_chat',
    entityId: ctx.userId || 0,
    action: 'chat',
    before: null,
    after: {
      message: message.slice(0, 500),
      tool_calls: allToolCalls,
      tokens_used: tokensUsed,
      latency_ms: latencyMs,
      reply_preview: (finalReply || '').slice(0, 200),
      confirm: confirmPayload ? { confirmation_id: confirmPayload.confirmation_id, tool: confirmPayload.tool } : null
    },
    source: 'ai_chat',
    userId: ctx.userId
  });

  return {
    reply: finalReply,
    chips: finalChips,
    tool_calls: allToolCalls,
    tokens_used: tokensUsed,
    latency_ms: latencyMs,
    confirm: confirmPayload,
    audit_id: `${ctx.userId || 0}_${Date.now()}`
  };
}

async function callLLM(messages, userId) {
  try {
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
    const parsed = JSON.parse(text);
    return {
      reply: parsed.reply || '',
      chips: Array.isArray(parsed.chips) ? parsed.chips : [],
      tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
    };
  } catch (e) {
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

// ── Keyword-based mutation intent detection ──────────────────────────
const MUTATION_PATTERNS = [
  {
    tool: 'create_customer',
    patterns: [/add\s+(?:a\s+)?customer/i, /create\s+(?:a\s+)?customer/i, /new\s+customer/i],
    extract: (msg) => {
      const nameMatch = msg.match(/(?:named|called|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
      const emailMatch = msg.match(/([\w._%+-]+@[\w.-]+\.[A-Za-z]{2,})/);
      const phoneMatch = msg.match(/(?:\d{3}[-.]?\d{3}[-.]?\d{4})/);
      const addrMatch = msg.match(/(?:from|in|at)\s+(.+?)(?:,|\.|\s+email|\s+phone|$)/);
      const args = { name: nameMatch ? nameMatch[1].trim() : '' };
      if (emailMatch) args.email = emailMatch[1];
      if (phoneMatch) args.phone = phoneMatch[0];
      if (addrMatch && addrMatch[1].trim().length < 80) {
        const addr = addrMatch[1].trim();
        // Try to split city/state
        const csMatch = addr.match(/^(.+?),\s*([A-Z]{2})\s*(\d{5})?$/);
        if (csMatch) { args.city = csMatch[1].trim(); args.state = csMatch[2]; if (csMatch[3]) args.zip = csMatch[3]; }
        else { args.address = addr; }
      }
      return args;
    }
  },
  {
    tool: 'send_estimate',
    patterns: [/send\s+(?:the\s+)?estimate/i, /send\s+EST/i],
    extract: (msg) => {
      const idMatch = msg.match(/EST[-\s]*(\d+)/i) || msg.match(/estimate[#\s]*(\d+)/i);
      return { estimate_id: idMatch ? parseInt(idMatch[1], 10) : 0 };
    }
  },
  {
    tool: 'mark_invoice_paid',
    patterns: [/mark\s+(?:as\s+)?paid/i, /pay\s+(?:the\s+)?invoice/i, /invoice.*paid/i],
    extract: (msg) => {
      const idMatch = msg.match(/INV[-\s]*(\d+)/i) || msg.match(/invoice[#\s]*(\d+)/i);
      return { invoice_id: idMatch ? parseInt(idMatch[1], 10) : 0 };
    }
  },
  {
    tool: 'approve_bill',
    patterns: [/approve\s+(?:the\s+)?bill/i],
    extract: (msg) => {
      const idMatch = msg.match(/bill[#\s]*(\d+)/i) || msg.match(/(\d+)/);
      return { bill_id: idMatch ? parseInt(idMatch[1], 10) : 0 };
    }
  },
  {
    tool: 'add_wo_note',
    patterns: [/add\s+(?:a\s+)?note/i, /leave\s+(?:a\s+)?note/i],
    extract: (msg) => {
      const woMatch = msg.match(/WO[-.\s]*(\d+)/i) || msg.match(/work\s*order[#\s]*(\d+)/i);
      const bodyMatch = msg.match(/(?:saying|that says|:)\s*(.+)/i);
      return { wo_id: woMatch ? parseInt(woMatch[1], 10) : 0, body: bodyMatch ? bodyMatch[1].trim() : '' };
    }
  },
  {
    tool: 'schedule_wo',
    patterns: [/schedule\s+(?:the\s+)?WO/i, /schedule\s+work\s*order/i, /book\s+(?:the\s+)?WO/i],
    extract: (msg) => {
      const scheduling = require('./scheduling');
      const woMatch = msg.match(/WO[-.\s]*(\d+(?:-\d+)*)/i);
      const timeMatch = msg.match(/(?:at\s+|@\s*)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
      let args = { wo_id: 0, date: '', time: '' };

      if (woMatch) args.wo_id = parseInt(woMatch[1], 10);
      if (timeMatch) args.time = scheduling.parseTime(timeMatch[1]) || timeMatch[1];

      // Extract name: capitalized word(s) after "for" or "to", but not a day name
      let nameText = null;
      const nameMatch = msg.match(/(?:for|to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
      if (nameMatch) {
        let candidate = nameMatch[1];
        // Strip trailing day names from the candidate (e.g., "Mike Thursday" → "Mike")
        const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday','today','tomorrow'];
        const words = candidate.split(/\s+/);
        while (words.length > 1 && dayNames.includes(words[words.length-1].toLowerCase())) {
          words.pop();
        }
        candidate = words.join(' ');
        if (candidate.length > 0 && !dayNames.includes(candidate.toLowerCase())) {
          nameText = candidate;
        }
      }

      // Extract date: look for relative day names or month-day patterns
      // Try after "for" first, stripping the name part
      let dateText = null;
      const forMatch = msg.match(/for\s+(.+?)(?:at\s+|$)/i);
      if (forMatch) {
        let rest = forMatch[1].trim();
        // If we found a name, remove it from the date search
        if (nameText) {
          rest = rest.replace(new RegExp('^' + nameText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').trim();
        }
        if (rest) {
          const parsed = scheduling.parseDate(rest);
          if (parsed) dateText = parsed;
          else {
            // Try absolute date pattern from the full message
            const absDate = msg.match(/(?:on\s+|for\s+)?(May|June|July|August|April|March|January|February|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
            if (absDate) dateText = scheduling.parseDate(absDate[0]);
          }
        }
      }

      // Also try standalone date patterns in the message
      if (!dateText) {
        const dayRef = msg.match(/(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
        if (dayRef) dateText = scheduling.parseDate(dayRef[0]);
        if (!dateText) {
          const absDate = msg.match(/(?:on\s+|for\s+)?(May|June|July|August|April|March|January|February|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
          if (absDate) dateText = scheduling.parseDate(absDate[1] + ' ' + absDate[2]);
        }
      }

      if (dateText) args.date = dateText;
      if (nameText) args.assignee_name = nameText;

      return args;
    }
  },
  {
    tool: 'reschedule_wo',
    patterns: [/reschedule\s+(?:the\s+)?WO/i, /reschedule\s+work\s*order/i, /move\s+(?:the\s+)?WO/i, /push\s+(?:back\s+)?WO/i],
    extract: (msg) => {
      const woMatch = msg.match(/WO[-.\s]*(\d+(?:-\d+)*)/i);
      const scheduling = require('./scheduling');
      // Try "to [date]" or "to next [day]"
      let dateStr = msg.match(/(?:to|for)\s+(.+?)$/i);
      let args = { wo_id: 0, new_date: '', new_time: '' };
      if (woMatch) args.wo_id = parseInt(woMatch[1], 10);
      if (dateStr) {
        args.new_date = scheduling.parseDate(dateStr[1]) || dateStr[1].trim();
        // Check for time in the rest
        const timeInDate = dateStr[1].match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
        if (timeInDate) args.new_time = scheduling.parseTime(timeInDate[1]) || timeInDate[1];
      }
      return args;
    }
  },
  {
    tool: 'assign_wo',
    patterns: [/assign\s+(?:the\s+)?WO/i, /reassign\s+(?:the\s+)?WO/i],
    extract: (msg) => {
      const woMatch = msg.match(/WO[-.\s]*(\d+(?:-\d+)*)/i);
      const nameMatch = msg.match(/(?:to|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
      let args = { wo_id: 0, assignee_name: '' };
      if (woMatch) args.wo_id = parseInt(woMatch[1], 10);
      if (nameMatch) args.assignee_name = nameMatch[1].trim();
      return args;
    }
  }
];

function detectMutationIntent(message, ctx) {
  for (const mp of MUTATION_PATTERNS) {
    if (mp.patterns.some(p => p.test(message))) {
      const args = mp.extract(message);
      return { tool: mp.tool, args };
    }
  }
  return null;
}
