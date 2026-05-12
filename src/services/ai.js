/**
 * AI service — provider-agnostic wrapper.
 *
 * Reads `AI_PROVIDER` + `AI_API_KEY` from env. Supports DeepSeek (default),
 * OpenAI, and Anthropic. Uses the provider's chat-completions / messages API
 * with JSON-structured output where available.
 *
 * Public:
 *   isConfigured()                                          -> boolean
 *   extract({ system, user, schemaHint, taskName, userId }) -> { ok, data, tokens, raw }
 *   suggest({ system, user, taskName, userId })             -> { ok, text, tokens }
 *   extractWorkOrder({ text, customers, users, userId })    -> { ok, data, tokens }
 *
 * Every call writes a row to audit_logs with source='ai'. The actual
 * financial / operational mutation never happens inside ai.js — callers
 * land output in a suggestion surface (form pre-fill, ai_extractions row)
 * and require explicit user approval.
 *
 * Caps for safety:
 *   - input text capped at 8000 chars (truncation + warning)
 *   - max tokens output capped at 2000
 *   - 30s request timeout
 */

const { writeAudit } = require('./audit');

const TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 2000;

function provider() {
  return (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
}
function modelName(prov = provider()) {
  const modelMap = {
    deepseek: process.env.DEEPSEEK_MODEL || process.env.AI_MODEL,
    openai: process.env.OPENAI_MODEL || process.env.GPT_MODEL,
    anthropic: process.env.ANTHROPIC_MODEL,
  };
  return modelMap[prov] || PROVIDERS[prov]?.model || '';
}
function apiKey() {
  return providerKey(provider());
}
function providerKey(prov) {
  if (prov === 'deepseek') return process.env.DEEPSEEK_API_KEY || process.env.AI_API_KEY || '';
  if (prov === 'openai') return process.env.OPENAI_API_KEY || process.env.GPT_API_KEY || '';
  if (prov === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  return '';
}
function isConfigured() {
  return configuredProviders().length > 0;
}
function configuredProviders() {
  return Object.keys(PROVIDERS).filter(providerKey);
}
function providerForTask(taskName = '') {
  const task = String(taskName || '').toLowerCase();
  const preferred = provider();
  if (/vision|image|photo|ocr|pdf-image|premium|gpt/.test(task) && providerKey('openai')) return 'openai';
  if (providerKey(preferred)) return preferred;
  if (providerKey('deepseek')) return 'deepseek';
  if (providerKey('openai')) return 'openai';
  if (providerKey('anthropic')) return 'anthropic';
  return preferred;
}

const PROVIDERS = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    auth: k => ({ Authorization: `Bearer ${k}` }),
    body: ({ system, user, json, model }) => ({
      model: model || 'deepseek-chat',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: json ? { type: 'json_object' } : undefined,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    }),
    extract: r => ({
      text: r.choices?.[0]?.message?.content || '',
      tokens: r.usage ? (r.usage.total_tokens || 0) : 0,
    }),
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    auth: k => ({ Authorization: `Bearer ${k}` }),
    body: ({ system, user, json, model }) => ({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: json ? { type: 'json_object' } : undefined,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    }),
    extract: r => ({
      text: r.choices?.[0]?.message?.content || '',
      tokens: r.usage ? (r.usage.total_tokens || 0) : 0,
    }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5',
    auth: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    body: ({ system, user, model }) => ({
      model: model || 'claude-haiku-4-5',
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
    }),
    extract: r => ({
      text: r.content?.[0]?.text || '',
      tokens: (r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0),
    }),
  },
};

function logCall({ taskName, userId, ok, tokens, reason, provider: prov, model }) {
  writeAudit({
    entityType: 'ai_call', entityId: 0, action: 'invoke',
    before: null,
    after: { provider: prov || provider(), model: model || null, task: taskName, ok, tokens: tokens || null, reason: reason || null },
    source: 'ai', userId: userId || null, reason: taskName,
  });
}

async function callProviderFor({ provider: prov, system, user, json, taskName, userId }) {
  const key = providerKey(prov);
  const model = modelName(prov);
  if (!key) {
    logCall({ taskName, userId, ok: false, reason: `no_api_key_for_${prov}`, provider: prov, model });
    return { ok: false, reason: `${prov} API key not configured - set ${prov === 'deepseek' ? 'AI_API_KEY or DEEPSEEK_API_KEY' : prov.toUpperCase() + '_API_KEY'} in env.` };
  }
  const cfg = PROVIDERS[prov];
  if (!cfg) {
    logCall({ taskName, userId, ok: false, reason: 'bad_provider', provider: prov, model });
    return { ok: false, reason: `Unknown provider "${prov}". Use deepseek | openai | anthropic.` };
  }

  if (user.length > MAX_INPUT_CHARS) {
    user = user.slice(0, MAX_INPUT_CHARS) + '\n\n[truncated]';
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(cfg.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...cfg.auth(key) },
      body: JSON.stringify(cfg.body({ system, user, json, model })),
    });
    clearTimeout(t);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const reason = `HTTP ${resp.status}: ${errBody.slice(0, 200)}`;
      logCall({ taskName, userId, ok: false, reason, provider: prov, model });
      return { ok: false, reason };
    }
    const data = await resp.json();
    const out = cfg.extract(data);
    logCall({ taskName, userId, ok: true, tokens: out.tokens, provider: prov, model });
    return { ok: true, text: out.text, tokens: out.tokens, raw: data, provider: prov, model };
  } catch (err) {
    clearTimeout(t);
    const reason = err.name === 'AbortError' ? 'request_timeout' : (err.message || String(err));
    logCall({ taskName, userId, ok: false, reason, provider: prov, model });
    return { ok: false, reason };
  }
}

async function callProvider({ system, user, json, taskName, userId }) {
  return callProviderFor({ provider: providerForTask(taskName), system, user, json, taskName, userId });
}

/** Free-form suggestion (text in, text out). */
async function suggest({ system, user, taskName, userId }) {
  return callProvider({ system, user, json: false, taskName, userId });
}

/**
 * Structured extraction. Caller provides `system` + `user` prompts that
 * specify a JSON schema; we ask the provider for JSON output and parse it.
 * Returns { ok, data, tokens } with `data` as the parsed JSON.
 */
async function extract({ system, user, taskName, userId }) {
  const r = await callProvider({ system, user, json: true, taskName, userId });
  if (!r.ok) return r;
  let parsed;
  try {
    parsed = JSON.parse(r.text);
  } catch (e) {
    return { ok: false, reason: `AI returned non-JSON. Raw: ${r.text.slice(0, 200)}`, tokens: r.tokens };
  }
  return { ok: true, data: parsed, tokens: r.tokens, raw: r.text };
}

// --- domain extraction: parse a free-text WO description ---

function buildExtractWorkOrderPrompts({ customers, users }) {
  const customerList = (customers || []).slice(0, 100)
    .map(c => `  - id=${c.id}: "${c.name}"`).join('\n') || '  (none)';
  const userList = (users || []).slice(0, 100)
    .map(u => `  - id=${u.id}: "${u.name}"`).join('\n') || '  (none)';

  const system = [
    'You parse free-text construction work-order descriptions into structured JSON.',
    'You return ONLY valid JSON matching the schema below. No markdown fences. No commentary.',
    'You SUGGEST — never assume. When unsure, leave fields null and lower the confidence.',
    '',
    'Schema:',
    '{',
    '  "customer": {',
    '    "match_id": <number|null, id from existing customers list if confident match>,',
    '    "name": "<extracted customer or company name>",',
    '    "match_confidence": <0..1>,',
    '    "evidence": "<short quote from input that justified the match>"',
    '  },',
    '  "job": {',
    '    "title": "<concise 4-10 word job title>",',
    '    "address": "<extracted street/unit/apt if mentioned, else null>",',
    '    "city": null, "state": null, "zip": null,',
    '    "description": "<expanded description preserving the original details and intent>",',
    '    "scheduled_date": null, "scheduled_time": null',
    '  },',
    '  "assignees": [',
    '    { "kind": "user"|"text", "name": "<name>", "user_id": <id|null>, "match_confidence": <0..1> }',
    '  ],',
    '  "line_items": [',
    '    { "description": "<line item>", "trade_hint": "<demo|cabinetry|countertops|plumbing|electrical|general|other>",',
    '      "quantity": <number|null>, "unit": "<ea|hr|sqft|lf|ton|lot>", "estimated_unit_price": <number|null> }',
    '  ],',
    '  "notes": "<anything important the user said that doesn\'t fit elsewhere — preserve constraints like reuse-if-possible>",',
    '  "overall_confidence": <0..1>,',
    '  "warnings": ["<short string per concern, e.g. \'no scheduled date provided\'>"]',
    '}',
    '',
    'Rules:',
    '- For assignees, prefer matching to existing users when the name is close (case-insensitive substring or last-name match).',
    '- "Office" or department-like labels = kind="text" with user_id=null.',
    '- Customer match: only set match_id when confident; otherwise return name only and let the system create a new customer.',
    '- Line items: be conservative. If user says "demo and replace cabinets and maybe replace countertops", suggest:',
    '    1. demo line, 2. new cabinets line, 3. new countertops line marked as conditional in description, 4. labor/installation lines if appropriate.',
    '- DO NOT invent prices. Leave estimated_unit_price null unless the input clearly states a price.',
    '- Preserve the user\'s constraints (e.g., "save countertops if reusable", "reuse plumbing") in line item descriptions and the notes field.',
  ].join('\n');

  const user = [
    'Existing customers (id: name):',
    customerList,
    '',
    'Existing employees (id: name):',
    userList,
    '',
    'Free-text work-order description to parse:',
    '"""',
    '<<INPUT>>',
    '"""',
  ].join('\n');

  return { system, userTemplate: user };
}

/**
 * Parse a free-text WO description into a structured suggestion.
 * Returns { ok, data, tokens } where data matches the schema in the prompt.
 */
async function extractWorkOrder({ text, customers, users, userId }) {
  const { system, userTemplate } = buildExtractWorkOrderPrompts({ customers, users });
  const user = userTemplate.replace('<<INPUT>>', String(text || '').slice(0, MAX_INPUT_CHARS));
  return extract({ system, user, taskName: 'extract_work_order', userId });
}

module.exports = {
  isConfigured, provider, modelName, providerForTask, configuredProviders,
  suggest, extract, callProviderFor,
  extractWorkOrder,
};
