/**
 * ai-assistant-state.js — Entity hierarchy guardrail + intent stack (D-064).
 *
 * Entity hierarchy invariant:
 *   customer → work_order → estimate → invoice  (bill → vendor)
 *
 * No child entity can be created without its parent existing first.
 * The state machine maintains an intent stack so the AI can:
 *   1. Detect a missing parent → push child intent onto stack
 *   2. Start parent creation flow
 *   3. On parent completion → pop stack and resume child intent
 *   4. On user cancel → clear the stack entry
 *
 * All entities also depend on customer (the root).
 */

const supabase = require('../db/supabase');

// ── Entity Hierarchy Definition ────────────────────────────────────────

/**
 * Maps each entity type to its required parent(s).
 * 'parents': array of { type, field, label } — the parent entity type, the DB column that references it,
 *            and the human-readable label for prompts.
 * 'createTool': the mutation tool name used to create this entity.
 * 'searchTool': the tool name used to search/lookup this entity (if any).
 * 'displayField': which DB column to show as the entity's display name.
 */
const ENTITY_HIERARCHY = {
  customer: {
    parents: [],
    createTool: 'create_customer',
    displayField: 'name',
    label: 'customer',
  },
  work_order: {
    parents: [{ type: 'customer', field: 'customer_id', label: 'customer' }],
    createTool: null, // currently navigate → /work-orders/ai-create
    displayField: 'display_number',
    label: 'work order',
  },
  estimate: {
    parents: [
      { type: 'customer', field: 'customer_id', label: 'customer' },
      { type: 'work_order', field: 'work_order_id', label: 'work order' },
    ],
    createTool: null,
    displayField: 'display_number',
    label: 'estimate',
  },
  invoice: {
    parents: [
      { type: 'customer', field: 'customer_id', label: 'customer' },
      { type: 'estimate', field: 'estimate_id', label: 'estimate' },
    ],
    createTool: null,
    displayField: 'display_number',
    label: 'invoice',
  },
  bill: {
    parents: [{ type: 'vendor', field: 'vendor_id', label: 'vendor' }],
    createTool: 'create_bill',
    // Also depends on customer for the vendor itself, but vendor exists independently
    displayField: 'bill_number',
    label: 'bill',
  },
};

// ── Stack Management ──────────────────────────────────────────────────

/**
 * An intent stack entry looks like:
 * {
 *   tool: 'navigate',          // the mutation tool the user originally asked for
 *   args: { path: '...' },     // the args for that tool
 *   entityType: 'work_order',  // the entity type being created
 *   parentName: 'Plymouth Square', // the parent entity name the user gave (if any)
 *   pendingParent: 'customer', // what parent we're currently creating
 * }
 */

function pushStack(stack, entry) {
  const s = Array.isArray(stack) ? stack.slice() : [];
  s.push(entry);
  return s;
}

function popStack(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return { stack: [], entry: null };
  const s = stack.slice();
  const entry = s.pop();
  return { stack: s, entry };
}

function peekStack(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return null;
  return stack[stack.length - 1];
}

function clearStack() {
  return [];
}

/**
 * Check if a given message is a "yes" response to "want me to create X first?"
 */
function isAffirmCreateParent(message) {
  return /^(yes|yeah|sure|ok|okay|go ahead|please|do it)\b/i.test(String(message || '').trim());
}

/**
 * Check if a given message is a "no" / "different name" response.
 */
function isRejectCreateParent(message) {
  return /^(no|nope|nah|cancel|stop|forget it|never mind)\b/i.test(String(message || '').trim());
}

/**
 * Extract a parent entity name from the user's "different name" response.
 */
function extractDifferentName(message) {
  // "different name: X" or just "X"
  const match = String(message || '').match(/(?:different name|actually|i mean|try)\s*(?::\s*)?['"]?([A-Za-z0-9][A-Za-z0-9 .'-]+)['"]?/i);
  if (match && match[1].trim().length >= 2) return match[1].trim();
  // Fallback: if message is just a name-like string (not a yes/no)
  const msg = String(message || '').trim();
  if (/^[A-Za-z][A-Za-z0-9 .'-]{1,60}$/.test(msg)) return msg;
  return null;
}

// ── Parent Existence Checks ──────────────────────────────────────────

/**
 * Check whether a parent entity exists in the DB.
 * Returns { exists: boolean, id: number|null, name: string|null, data: object|null }
 */
async function checkParentExists(parentType, searchTerm) {
  if (!searchTerm || !searchTerm.trim()) return { exists: false, id: null, name: null, data: null };

  const cleanTerm = searchTerm.trim();
  let result = { exists: false, id: null, name: null, data: null };

  try {
    if (parentType === 'customer') {
      // Try exact match first, then fuzzy
      const { data, error } = await supabase
        .from('customers')
        .select('id, name')
        .or(`name.ilike.%${cleanTerm}%,email.ilike.%${cleanTerm}%,phone.ilike.%${cleanTerm}%`)
        .limit(10);

      if (error) throw error;
      if (data && data.length > 0) {
        // Exact match wins
        const exact = data.find(c => c.name.toLowerCase() === cleanTerm.toLowerCase());
        const match = exact || data[0];
        return { exists: true, id: match.id, name: match.name, data: match, matches: data.length > 1 ? data : null };
      }
    } else if (parentType === 'work_order') {
      const { data, error } = await supabase
        .from('work_orders')
        .select('id, display_number, customer_id')
        .ilike('display_number', `%${cleanTerm}%`)
        .limit(10);

      if (error) throw error;
      if (data && data.length > 0) {
        const match = data[0];
        return { exists: true, id: match.id, name: match.display_number, data: match, matches: data.length > 1 ? data : null };
      }
    } else if (parentType === 'estimate') {
      const { data, error } = await supabase
        .from('estimates')
        .select('id, display_number, customer_id, work_order_id')
        .ilike('display_number', `%${cleanTerm}%`)
        .limit(10);

      if (error) throw error;
      if (data && data.length > 0) {
        const match = data[0];
        return { exists: true, id: match.id, name: match.display_number, data: match, matches: data.length > 1 ? data : null };
      }
    } else if (parentType === 'vendor') {
      const { data, error } = await supabase
        .from('vendors')
        .select('id, name')
        .or(`name.ilike.%${cleanTerm}%,email.ilike.%${cleanTerm}%`)
        .limit(10);

      if (error) throw error;
      if (data && data.length > 0) {
        const match = data[0];
        return { exists: true, id: match.id, name: match.name, data: match, matches: data.length > 1 ? data : null };
      }
    }
  } catch (e) {
    // Log but don't crash — fall through to "not found"
    console.warn('[ai-assistant-state] checkParentExists error:', e.message);
  }

  return result;
}

// ── Entity Type Resolution ────────────────────────────────────────────

/**
 * Given a mutation tool name and its args, resolve which entity type
 * the user is trying to create and what parent name (if any) they mentioned.
 */
function resolveEntityInfo(tool, args) {
  if (tool === 'create_customer') return { entityType: 'customer', parentName: null };
  if (tool === 'navigate' && args && args.path && args.path.startsWith('/work-orders/ai-create')) {
    // Extract a possible customer/entity mention from the draft
    const draft = args.path;
    const nameMatch = draft.match(/draft=([^&]+)/);
    const decoded = nameMatch ? decodeURIComponent(nameMatch[1]) : '';
    // Try to extract a named entity: "for X" at start
    const entityName = decoded.replace(/^(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?work\s*order\s*(?:for|to|at)\s+/i, '').split(/[,;]|schedule|for|unit|#/)[0].trim();
    return { entityType: 'work_order', parentName: entityName.length >= 2 ? entityName : null };
  }
  // estimate creation via AI (future tool)
  if (tool === 'create_estimate') return { entityType: 'estimate', parentName: (args && args.customer_name) || null };
  if (tool === 'create_invoice') return { entityType: 'invoice', parentName: (args && args.customer_name) || null };

  return { entityType: null, parentName: null };
}

// ── Main Guardrail Entry Point ────────────────────────────────────────

/**
 * Checks the entity hierarchy for a detected mutation intent.
 *
 * Returns one of:
 * - { ok: true, needs_parent: false } — all parents exist, proceed normally
 * - { ok: true, needs_parent: true, parentType, parentName, reply, stack } — ask user to create parent first
 * - { ok: false, error: string } — something went wrong
 */
async function checkEntityHierarchy(tool, args, ctx, currentStack) {
  const { entityType, parentName } = resolveEntityInfo(tool, args);
  if (!entityType) {
    // Not a hierarchy-managed entity type, pass through
    return { ok: true, needs_parent: false, stack: currentStack };
  }

  const hierarchy = ENTITY_HIERARCHY[entityType];
  if (!hierarchy || hierarchy.parents.length === 0) {
    // Root entity (customer), no parent needed
    return { ok: true, needs_parent: false, stack: currentStack };
  }

  // If the user said "make an invoice" / "create an estimate" without specifying
  // any parent info, ask for the parent first before checking existence.
  const infoMissing = hierarchy.parents.some(function(p) {
    if (p.type === 'customer') return !parentName;
    if (p.type === 'work_order' && entityType === 'estimate') return !args.work_order_id && !parentName;
    if (p.type === 'estimate' && entityType === 'invoice') return !args.estimate_id && !parentName;
    return false;
  });
  if (infoMissing) {
    // Let buildMissingMutationReply handle the "need more info" response
    return { ok: true, needs_parent: false, stack: currentStack };
  }

  // Check each parent in order
  for (const parent of hierarchy.parents) {
    if (parent.type === 'customer' && parentName) {
      const result = await checkParentExists('customer', parentName);
      if (!result.exists && result.matches && result.matches.length > 1) {
        return {
          ok: true,
          needs_parent: true,
          disambiguate: true,
          parentType: 'customer',
          parentName,
          matches: result.matches,
          reply: `I found multiple customers matching "${parentName}". Which one did you mean?`,
          stack: currentStack
        };
      }
      if (!result.exists) {
        const newStack = pushStack(currentStack || [], {
          tool,
          args: args || {},
          entityType,
          parentName,
          pendingParent: 'customer',
        });
        return {
          ok: true,
          needs_parent: true,
          parentType: 'customer',
          parentName,
          stack: newStack,
          reply: `I don't have a customer named "${parentName}" on file. Want me to create them first? (yes / no / different name)`
        };
      }
    } else if (parent.type === 'work_order' && entityType === 'estimate') {
      const woId = args && args.work_order_id;
      const woName = parentName;
      if (woId) {
        const result = await checkParentExists('work_order', String(woId));
        if (!result.exists) {
          const newStack = pushStack(currentStack || [], {
            tool, args: args || {}, entityType, parentName,
            pendingParent: 'work_order',
          });
          return {
            ok: true, needs_parent: true, parentType: 'work_order',
            parentName: String(woId), stack: newStack,
            reply: `I don't see work order matching that. Want me to create one first? (yes / no)`
          };
        }
      }
    } else if (parent.type === 'estimate' && entityType === 'invoice') {
      const estId = args && args.estimate_id;
      const estName = parentName;
      if (estId) {
        const result = await checkParentExists('estimate', String(estId));
        if (!result.exists) {
          const newStack = pushStack(currentStack || [], {
            tool, args: args || {}, entityType, parentName,
            pendingParent: 'estimate',
          });
          return {
            ok: true, needs_parent: true, parentType: 'estimate',
            parentName: String(estId), stack: newStack,
            reply: `An invoice needs an approved estimate first. Want me to draft one? (yes / no)`
          };
        }
      }
    }
  }

  // All parents exist
  return { ok: true, needs_parent: false, stack: currentStack };
}

// ── Stack Resume Logic ────────────────────────────────────────────────

/**
 * After a parent entity creation completes, check the stack for pending child intents.
 * Returns the resumed intent if one exists, or null.
 */
function resumeFromStack(stack, completedEntityType) {
  if (!Array.isArray(stack) || stack.length === 0) return null;
  const entry = peekStack(stack);
  if (!entry) return null;
  if (entry.pendingParent === completedEntityType) {
    return entry; // Return the entry so caller can pop and resume
  }
  return null;
}

/**
 * Build a "resume" reply after a parent entity was created.
 */
function buildResumeReply(stackEntry) {
  if (!stackEntry) return null;
  const entityLabel = ENTITY_HIERARCHY[stackEntry.entityType]?.label || stackEntry.entityType;
  if (stackEntry.entityType === 'work_order') {
    return `Customer created! Now, what should the ${entityLabel} include? Give me the scope of work, schedule, and any assignee details.`;
  }
  return `Great, that's done. Now let's set up the ${entityLabel}. What details should I include?`;
}

module.exports = {
  ENTITY_HIERARCHY,
  checkParentExists,
  checkEntityHierarchy,
  resolveEntityInfo,
  pushStack,
  popStack,
  peekStack,
  clearStack,
  isAffirmCreateParent,
  isRejectCreateParent,
  extractDifferentName,
  resumeFromStack,
  buildResumeReply,
};
