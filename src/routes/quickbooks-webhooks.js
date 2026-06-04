const crypto = require('crypto');
const express = require('express');

const router = express.Router();
let supabaseClient = null;

function db() {
  if (!supabaseClient) supabaseClient = require('../db/supabase');
  return supabaseClient;
}

function getVerifierToken() {
  return process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN || '';
}

function signatureFor(rawBody, token) {
  return crypto
    .createHmac('sha256', token)
    .update(rawBody)
    .digest('base64');
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyIntuitSignature(req) {
  const token = getVerifierToken();
  if (!token) return { ok: false, reason: 'QuickBooks webhook verifier token is not configured.' };

  const header = req.get('intuit-signature');
  if (!header) return { ok: false, reason: 'Missing intuit-signature header.' };

  const expected = signatureFor(req.body || Buffer.from(''), token);
  if (!timingSafeEqualString(header, expected)) {
    return { ok: false, reason: 'Invalid QuickBooks webhook signature.' };
  }
  return { ok: true };
}

async function recordWebhookEvent({ realmId, entityName, entityId, operation, lastUpdated, payload }) {
  const row = {
    realm_id: realmId || null,
    entity_name: entityName || null,
    entity_id: entityId || null,
    operation: operation || null,
    last_updated_at: lastUpdated || null,
    payload,
    processed_status: 'received',
  };
  const { error } = await db().from('quickbooks_webhook_events').insert(row);
  if (error) throw error;
}

function extractEvents(payload) {
  const notifications = Array.isArray(payload?.eventNotifications) ? payload.eventNotifications : [];
  const events = [];
  for (const notification of notifications) {
    const realmId = notification.realmId || null;
    const entities = Array.isArray(notification?.dataChangeEvent?.entities)
      ? notification.dataChangeEvent.entities
      : [];
    for (const entity of entities) {
      events.push({
        realmId,
        entityName: entity.name,
        entityId: entity.id,
        operation: entity.operation,
        lastUpdated: entity.lastUpdated,
      });
    }
  }
  return events;
}

router.post('/', async (req, res) => {
  const verification = verifyIntuitSignature(req);
  if (!verification.ok) {
    console.warn('[quickbooks-webhook] rejected:', verification.reason);
    return res.status(401).json({ ok: false });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}'));
  } catch (error) {
    console.warn('[quickbooks-webhook] invalid json:', error.message);
    return res.status(400).json({ ok: false });
  }

  const events = extractEvents(payload);
  try {
    if (events.length === 0) {
      await recordWebhookEvent({ payload });
    } else {
      for (const event of events) {
        await recordWebhookEvent({ ...event, payload });
      }
    }
  } catch (error) {
    console.error('[quickbooks-webhook] record failed:', error.message);
    return res.status(500).json({ ok: false });
  }

  res.status(200).json({ ok: true });
});

module.exports = router;
module.exports._internal = {
  extractEvents,
  signatureFor,
  timingSafeEqualString,
  verifyIntuitSignature,
};
