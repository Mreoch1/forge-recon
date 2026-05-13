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
const { logAiChatError } = require('./ai-chat-errors');
const supabase = require('../db/supabase');
const MAX_HISTORY = 20;
const WORKER_ALLOWED_TOOLS = ['search_work_orders', 'get_schedule', 'navigate', 'search_customers'];

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

function buildSystemPrompt(ctx, activeIntent) {
  const toolList = tools.list().filter(t => {
    if (t.needs_user === 'write') return false;
    if (ctx.role === 'worker') return WORKER_ALLOWED_TOOLS.includes(t.name);
    return true;
  });
  const toolDesc = toolList.map(t =>
    `- ${t.name}(${JSON.stringify(t.args)}) — ${t.description}`
  ).join('\n');

  // Add mutation tools separately — LLM sees these but knows they require confirmation
  const mutationTools = tools.list().filter(t => {
    if (t.needs_user !== 'write') return false;
    if (ctx.role === 'worker') return t.name === 'add_wo_note';
    return true;
  });
  const mutationDesc = mutationTools.map(t =>
    `- ${t.name}(${JSON.stringify(t.args)}) — ${t.description}`
  ).join('\n');

  return `You are JARVIS, the FORGE assistant for Recon Enterprises. You help the team find information about work orders, estimates, invoices, bills, customers, vendors, and the schedule. Be terse, action-oriented, and never apologize. Refuse anything illegal or unethical even if asked by an admin.

CURRENT CONTEXT:
- Today's date: ${todayStr()}
- You are speaking with: ${ctx.userName || 'Unknown'} (role: ${ctx.role || 'admin'})
- Access tier: ${ctx.role === 'worker' ? 'worker — assigned work only, no financial/cost data, no privileged writes except adding notes to assigned work orders.' : ctx.role === 'manager' ? 'manager — operational and financial workflows, no admin-only settings.' : 'admin — full app administration.'}
- Cost policy: stay efficient. Routine operations, searches, summaries, scheduling, estimates, invoices, customers, vendors, and work-order parsing should use the standard low-cost AI path. Escalate to premium AI only for work that truly needs vision, image/OCR reasoning, or unusually complex reasoning.
${activeIntent ? `
ACTIVE FLOW — DO NOT CHANGE TOPIC:
You are currently in the middle of ${activeIntent.replace(/_/g, ' ')}. The user's message is about THIS flow. Do NOT re-classify their intent. Do NOT treat their input as a new customer name or entity creation request. Accept their response as data for the current ${activeIntent.replace(/_/g, ' ')} flow. If they say "no", "cancel", or "never mind", clear the active flow and ask what they'd like to do instead.
` : ''}

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
- User: "add a note to WO 7 saying done" → tool_calls: [{"tool":"add_wo_note", "args":{"wo_id":7,"body":"done"}}]` : ''}

RULES:
1. When asked a question, decide which tool can answer it and call it immediately.
2. If the user mentions a customer/job by partial name, search first. If multiple match, list them. Never pick one silently.
3. After tools return, give a short natural-language answer (1-3 sentences). No fluff.
4. If a tool returns nothing useful, say so directly. Do not invent records.
5. If off-topic, say "I can only answer questions about Recon's operations data" once and move on.
6. For mutation requests, ALWAYS search for the entity ID first, then include the action tool in the SAME tool_calls array.
7. Stay inside the user's tier. Never expose cost, invoice, estimate, bill, admin, or other privileged data to a worker. Never help bypass permissions.
8. If the user gives incomplete action details, ask ONE clear follow-up question and keep the draft context alive.
9. When the user asks to create or change something and there is a dedicated FORGE page for it, offer a navigation chip to that workflow while gathering the missing details.
10. Never create images, media, or content outside of FORGE operations.

Respond ONLY with a JSON object:
{
  "reply": "your natural language answer here",
  "chips": [{"label": "button text", "href": "/path"}],
  "tool_calls": [{"tool": "tool_name", "args": {"arg1": "value1"}}]
}`;
}

async function chat({ message, history, ctx, active_intent }) {
  const startTime = Date.now();

  if (!ai.isConfigured() && !process.env.AI_CHAT_ENABLED) {
    return { reply: 'AI chat is not configured.', chips: [], tool_calls: [], audit_id: null };
  }

  if (active_intent && isCancelFlowMessage(message)) {
    return {
      reply: 'Okay, I cleared that FORGE flow. What would you like to do next?',
      chips: [],
      tool_calls: [],
      tokens_used: 0,
      latency_ms: Date.now() - startTime,
      confirm: null,
      audit_id: `${ctx.userId || 0}_${Date.now()}`,
      active_intent: null
    };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(ctx, active_intent) },
    ...(history || []).slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ];

  let finalReply = '';
  let finalChips = [];
  let allToolCalls = [];
  let tokensUsed = 0;
  let confirmPayload = null;
  let resultActiveIntent = active_intent || null;

  // Pre-chat: keep guided write flows deterministic before falling back to the LLM.
  const mutationIntent = resolveMutationIntent(message, history, ctx, active_intent);
  if (mutationIntent) {
    allToolCalls.push({ tool: mutationIntent.tool, args: mutationIntent.args });
    resultActiveIntent = mutationIntent.tool;

    const missingReply = buildMissingMutationReply(mutationIntent);
    if (missingReply) {
      const missingChips = buildMissingMutationChips(mutationIntent);
      return {
        reply: missingReply,
        chips: missingChips,
        tool_calls: allToolCalls,
        tokens_used: 0,
        latency_ms: Date.now() - startTime,
        confirm: null,
        audit_id: `${ctx.userId || 0}_${Date.now()}`,
        active_intent: resultActiveIntent
      };
    }

    const proposeResult = await tools.propose(mutationIntent.tool, mutationIntent.args, ctx);
    if (proposeResult.error) {
      const guidedError = buildGuidedErrorReply(mutationIntent.tool, proposeResult.error);
      return {
        reply: guidedError || proposeResult.error,
        chips: [], tool_calls: allToolCalls, tokens_used: 0,
        latency_ms: Date.now() - startTime, confirm: null,
        audit_id: `${ctx.userId || 0}_${Date.now()}`,
        active_intent: resultActiveIntent
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
        audit_id: `${ctx.userId || 0}_${Date.now()}`,
        active_intent: resultActiveIntent
      };
    }

    // Create pending confirmation — lock the active intent
    resultActiveIntent = mutationIntent.tool;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { data: r, error: insErr } = await supabase.from('pending_confirmations').insert({
      user_id: ctx.userId,
      tool: mutationIntent.tool,
      args: JSON.stringify(proposeResult.args_normalized || mutationIntent.args),
      summary: JSON.stringify(proposeResult.summary_lines),
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    }).select().single();
    if (insErr) throw insErr;

    return {
      reply: proposeResult.summary_lines.length > 0
        ? `I'll prepare to ${mutationIntent.tool.replace(/_/g, ' ')} with these details:`
        : `I'll prepare to ${mutationIntent.tool.replace(/_/g, ' ')}.`,
      chips: [],
      tool_calls: allToolCalls,
      tokens_used: 0,
      latency_ms: Date.now() - startTime,
      confirm: {
        confirmation_id: r.id,
        tool: mutationIntent.tool,
        summary_lines: proposeResult.summary_lines,
        warnings: proposeResult.warnings || [],
        expires_in_seconds: 300
      },
      audit_id: `${ctx.userId || 0}_${Date.now()}`,
      active_intent: resultActiveIntent
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
      resultActiveIntent = mc.tool;

      const missingReply = buildMissingMutationReply({ tool: mc.tool, args: mc.args || {} });
      if (missingReply) {
        finalReply = missingReply;
      } else {

      // Validate via propose function
      const proposeResult = await tools.propose(mc.tool, mc.args || {}, ctx);
      if (proposeResult.error) {
        finalReply = buildGuidedErrorReply(mc.tool, proposeResult.error) || proposeResult.error;
        // The reply should guide the user
        if (proposeResult.error.includes('not found')) {
          finalReply = buildGuidedErrorReply(mc.tool, proposeResult.error) || `I couldn't find that. Could you provide more details?`;
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
        // Create pending confirmation — lock the active intent
        resultActiveIntent = mc.tool;
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const { data: r2, error: insErr } = await supabase.from('pending_confirmations').insert({
          user_id: ctx.userId,
          tool: mc.tool,
          args: JSON.stringify(proposeResult.args_normalized || mc.args),
          summary: JSON.stringify(proposeResult.summary_lines),
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
        }).select().single();
        if (insErr) throw insErr;
        const confirmationId = r2.id;

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
    source: 'ai',
    userId: ctx.userId
  });

  return {
    reply: finalReply,
    chips: finalChips,
    tool_calls: allToolCalls,
    tokens_used: tokensUsed,
    latency_ms: latencyMs,
    confirm: confirmPayload,
    audit_id: `${ctx.userId || 0}_${Date.now()}`,
    active_intent: resultActiveIntent
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
    logAiChatError({ userId, errorType: 'provider_error', errorMessage: e.message, errorStack: e.stack, provider: 'deepseek' });
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

module.exports = { chat, buildSystemPrompt, logAiChatError };

// ── Keyword-based mutation intent detection ──────────────────────────
function extractNamedValue(message) {
  const match = message.match(/(?:named|called|for)\s+(.+?)(?:\s+(?:with|email|phone|from|in|at)\b|[,.;]|$)/i);
  if (!match) return '';
  return match[1]
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function cleanLooseName(value) {
  return String(value || '')
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, '')
    .replace(/\b(email|phone|address|billing email|billing)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCustomerArgs(message, opts = {}) {
  const msg = String(message || '');
  const emailMatch = msg.match(/([\w._%+-]+@[\w.-]+\.[A-Za-z]{2,})/);
  const phoneMatch = msg.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const billingEmailMatch = msg.match(/billing\s+email\s+(?:is\s+)?([\w._%+-]+@[\w.-]+\.[A-Za-z]{2,})/i);
  const addrMatch = msg.match(/(?:address\s+(?:is\s+)?|from|in|at)\s+(.+?)(?:,?\s+(?:email|phone|billing|notes?)\b|[.;]|$)/i);
  const billingAddressMatch = msg.match(/billing\s+address\s+(?:is\s+)?(.+?)(?:,?\s+(?:email|phone|address|contact|manager|notes?)\b|[.;]|$)/i);
  const contactMatch = msg.match(/(?:contact|manager|property manager)\s+(?:is\s+)?(.+?)(?:,?\s+(?:email|phone|address|billing|notes?)\b|[.;]|$)/i);

  let name = extractNamedValue(msg);
  if (!name && opts.allowLeadingName) {
    let leading = msg
      .replace(/([\w._%+-]+@[\w.-]+\.[A-Za-z]{2,})/g, '')
      .replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g, '')
      .replace(/\b(?:email|phone|address|billing email|billing|notes?)\b.*$/i, '');
    const split = leading.split(/[,;]|\s+-\s+/)[0];
    name = cleanLooseName(split);
  }

  const args = { name: cleanLooseName(name) };
  if (emailMatch) args.email = emailMatch[1];
  if (phoneMatch) args.phone = phoneMatch[0].trim();
  if (billingEmailMatch) args.billing_email = billingEmailMatch[1];
  if (addrMatch && addrMatch[1].trim().length < 120) {
    const addr = addrMatch[1].trim();
    const csMatch = addr.match(/^(.+?),\s*([A-Z]{2})\s*(\d{5})?$/);
    if (csMatch) {
      args.city = csMatch[1].trim();
      args.state = csMatch[2];
      if (csMatch[3]) args.zip = csMatch[3];
    } else {
      args.address = addr;
    }
  }
  const notes = [];
  if (billingAddressMatch && billingAddressMatch[1].trim().length < 160) notes.push(`Billing address: ${billingAddressMatch[1].trim()}`);
  if (contactMatch && contactMatch[1].trim().length < 120) args.contact_name = contactMatch[1].trim();
  if (notes.length) args.notes = notes.join('\n');
  return args;
}

function mergeCustomerArgs(base, next) {
  const merged = { ...(base || {}) };
  Object.entries(next || {}).forEach(([key, value]) => {
    if (!value) return;
    if (key === 'notes' && merged.notes && value !== merged.notes) {
      merged.notes = `${merged.notes}\n${value}`;
    } else {
      merged[key] = value;
    }
  });
  return merged;
}

function lastAssistantText(history) {
  const rows = Array.isArray(history) ? history : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i] && rows[i].role === 'assistant') return String(rows[i].content || '');
  }
  return '';
}

function customerDraftFromHistory(history) {
  const rows = Array.isArray(history) ? history : [];
  let draft = {};
  let active = false;
  for (const row of rows) {
    if (!row || typeof row.content !== 'string') continue;
    if (row.role === 'assistant' && /customer/i.test(row.content) && (/customer name/i.test(row.content) || /email|phone|billing|address|contact|manager/i.test(row.content))) {
      active = true;
      continue;
    }
    if (active && row.role === 'user') {
      draft = mergeCustomerArgs(draft, parseCustomerArgs(row.content, { allowLeadingName: !draft.name }));
    }
  }
  return draft;
}

function detectGuidedContinuation(message, history) {
  const last = lastAssistantText(history);
  if (isAwaitingCustomerDetails(last)) {
    const existing = customerDraftFromHistory(history);
    const incoming = parseCustomerArgs(message, { allowLeadingName: !existing.name });
    const args = mergeCustomerArgs(existing, incoming);
    if (isCustomerSkipReply(message)) args._customer_skip_missing = true;
    return { tool: 'create_customer', args };
  }
  if (isAwaitingCustomerName(last)) {
    return { tool: 'create_customer', args: parseCustomerArgs(message, { allowLeadingName: true }) };
  }
  if (/create the work order/i.test(last)) {
    return { tool: 'navigate', args: { path: `/work-orders/ai-create?draft=${encodeURIComponent(String(message || '').trim())}` } };
  }
  if (/which estimate/i.test(last)) {
    const idMatch = String(message || '').match(/EST[-\s]*(\d+)/i) || String(message || '').match(/estimate[#\s]*(\d+)/i) || String(message || '').match(/^#?(\d+)$/);
    if (idMatch) return { tool: 'send_estimate', args: { estimate_id: parseInt(idMatch[1], 10) } };
  }
  if (/which invoice/i.test(last)) {
    const idMatch = String(message || '').match(/INV[-\s]*(\d+)/i) || String(message || '').match(/invoice[#\s]*(\d+)/i) || String(message || '').match(/^#?(\d+)$/);
    if (idMatch) return { tool: 'mark_invoice_paid', args: { invoice_id: parseInt(idMatch[1], 10) } };
  }
  return null;
}

function isAwaitingCustomerName(text) {
  const last = String(text || '');
  return /customer/i.test(last)
    && (
      /to create a customer/i.test(last)
      || /create the customer/i.test(last)
      || /create.*customer/i.test(last)
      || /customer name/i.test(last)
      || /give me.*name/i.test(last)
    );
}

function isAwaitingCustomerDetails(text) {
  const last = String(text || '');
  return /customer/i.test(last)
    && (/do you know/i.test(last) || /not sure/i.test(last) || /what we have/i.test(last));
}

function isCustomerSkipReply(message) {
  return /^(no|nope|not sure|unsure|idk|i don't know|i dont know|unknown|skip|none|not now)\b/i.test(String(message || '').trim());
}

function customerMissingFields(args) {
  const missing = [];
  if (!args.email) missing.push('email');
  if (!args.phone) missing.push('phone');
  if (!args.address && !args.city && !args.state && !args.zip) missing.push('service address');
  if (!args.billing_email && !/billing address:/i.test(args.notes || '')) missing.push('billing email or billing address');
  if (!args.contact_name && !/contact\/manager:/i.test(args.notes || '')) missing.push('contact or manager name');
  return missing;
}

function customerIntakeReply(args) {
  const name = args.name ? ` for ${args.name}` : '';
  const missing = customerMissingFields(args);
  if (!missing.length || args._customer_skip_missing) return null;
  return `Got the customer name${name}. Do you know the ${missing.join(', ')}? Send whatever you have, or say "not sure" and I will create the customer with what we have.`;
}

function buildMissingMutationReply(intent) {
  const tool = intent && intent.tool;
  const args = (intent && intent.args) || {};
  if (tool === 'create_customer' && (!args.name || args.name.trim().length < 2)) {
    return 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.';
  }
  if (tool === 'create_customer') {
    const intakeReply = customerIntakeReply(args);
    if (intakeReply) return intakeReply;
  }
  if (tool === 'navigate' && args.path && String(args.path).startsWith('/work-orders/ai-create')) {
    return 'Absolutely. I can create the work order in FORGE. Give me the customer or property, unit if there is one, the scope of work, and any schedule or assignee details. I will open the AI work-order builder with that draft.';
  }
  if (tool === 'send_estimate' && !Number(args.estimate_id)) {
    return 'Which estimate should I send? Give me the estimate number, like EST-12, or the customer/job name so I can find it.';
  }
  if (tool === 'mark_invoice_paid' && !Number(args.invoice_id)) {
    return 'Which invoice should I mark paid? Give me the invoice number, like INV-12. If it is a partial payment, include the amount too.';
  }
  if (tool === 'approve_bill' && !Number(args.bill_id)) {
    return 'Which bill should I approve? Give me the bill number or bill ID.';
  }
  if (tool === 'add_wo_note') {
    if (!Number(args.wo_id)) return 'Which work order should I add the note to? Give me the WO number and the note text.';
    if (!args.body || args.body.trim().length < 2) return `What note should I add to WO-${args.wo_id}?`;
  }
  if (tool === 'schedule_wo') {
    if (!Number(args.wo_id)) return 'Which work order should I schedule? Give me the WO number, date, time, and assignee if needed.';
    if (!args.date) return `What date should I schedule WO-${args.wo_id} for?`;
  }
  if (tool === 'reschedule_wo') {
    if (!Number(args.wo_id)) return 'Which work order should I reschedule? Give me the WO number and the new date.';
    if (!args.new_date) return `What new date should I move WO-${args.wo_id} to?`;
  }
  if (tool === 'assign_wo') {
    if (!Number(args.wo_id)) return 'Which work order should I assign? Give me the WO number and assignee name.';
    if (!args.assignee_user_id && !args.assignee_name) return `Who should I assign WO-${args.wo_id} to?`;
  }
  return null;
}

function buildMissingMutationChips(intent) {
  const tool = intent && intent.tool;
  const args = (intent && intent.args) || {};
  if (tool === 'navigate' && args.path && String(args.path).startsWith('/work-orders/ai-create')) {
    return [{ label: 'Open work-order builder', href: args.path }];
  }
  return [];
}

function buildGuidedErrorReply(tool, error) {
  const text = String(error || '');
  if (/not found/i.test(text)) {
    if (tool === 'send_estimate') return 'I could not find that estimate. Send me the estimate number or customer/job name and I will look it up.';
    if (tool === 'mark_invoice_paid') return 'I could not find that invoice. Send me the invoice number or customer/job name and I will look it up.';
    if (tool === 'approve_bill') return 'I could not find that bill. Send me the bill number, vendor, or bill ID.';
    if (/wo|work/i.test(tool)) return 'I could not find that work order. Send me the WO number or customer/job name.';
  }
  if (/required/i.test(text)) return `${text} Send that detail and I will keep going.`;
  return null;
}

function workOrderBuilderPath(message) {
  const draft = String(message || '')
    .replace(/^(?:can you|could you|please|i need you to|help me|i need to|we need to)\s+/i, '')
    .replace(/^(?:help me\s+)?(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?work\s*order\s*(?:for|to|:)?\s*/i, '')
    .trim();
  return draft.length >= 8
    ? `/work-orders/ai-create?draft=${encodeURIComponent(draft)}`
    : '/work-orders/ai-create';
}

const MUTATION_PATTERNS = [
  {
    tool: 'navigate',
    patterns: [/create\s+(?:a\s+)?(?:new\s+)?work\s*order/i, /new\s+work\s*order/i, /make\s+(?:a\s+)?work\s*order/i],
    extract: (msg) => {
      return { path: workOrderBuilderPath(msg) };
    }
  },
  {
    tool: 'create_customer',
    patterns: [/add\s+(?:a\s+)?(?:new\s+)?customer/i, /create\s+(?:a\s+)?(?:new\s+)?customer/i, /new\s+customer/i],
    extract: (msg) => {
      return parseCustomerArgs(msg, { allowLeadingName: false });
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

function resolveMutationIntent(message, history, ctx, activeIntent) {
  const guidedIntent = detectGuidedContinuation(message, history);
  if (activeIntent) {
    return guidedIntent && guidedIntent.tool === activeIntent ? guidedIntent : null;
  }
  return guidedIntent || detectMutationIntent(message, ctx);
}

function isCancelFlowMessage(message) {
  return /^(no|nope|cancel|stop|never mind|nevermind|forget it|clear it|scratch that)\b/i.test(String(message || '').trim());
}

module.exports._internal = {
  parseCustomerArgs,
  detectGuidedContinuation,
  buildMissingMutationReply,
  buildMissingMutationChips,
  buildGuidedErrorReply,
  detectMutationIntent,
  resolveMutationIntent,
  isCancelFlowMessage,
  workOrderBuilderPath,
  isAwaitingCustomerName,
  isAwaitingCustomerDetails,
  customerDraftFromHistory,
  customerMissingFields,
  isCustomerSkipReply,
};
