const assert = require('node:assert/strict');
const test = require('node:test');

const webhook = require('../src/routes/quickbooks-webhooks');

test('QuickBooks webhook extracts entity events from Intuit payloads', () => {
  const events = webhook._internal.extractEvents({
    eventNotifications: [{
      realmId: '12345',
      dataChangeEvent: {
        entities: [
          { name: 'Invoice', id: '99', operation: 'Update', lastUpdated: '2026-06-04T12:00:00.000Z' },
          { name: 'Customer', id: '42', operation: 'Create', lastUpdated: '2026-06-04T12:01:00.000Z' },
        ],
      },
    }],
  });

  assert.deepEqual(events, [
    { realmId: '12345', entityName: 'Invoice', entityId: '99', operation: 'Update', lastUpdated: '2026-06-04T12:00:00.000Z' },
    { realmId: '12345', entityName: 'Customer', entityId: '42', operation: 'Create', lastUpdated: '2026-06-04T12:01:00.000Z' },
  ]);
});

test('QuickBooks webhook verifies Intuit HMAC signature', () => {
  const oldToken = process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN;
  process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = 'test-verifier-token';
  const rawBody = Buffer.from(JSON.stringify({ eventNotifications: [] }));
  const goodSignature = webhook._internal.signatureFor(rawBody, process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN);

  const goodReq = {
    body: rawBody,
    get(name) {
      return name === 'intuit-signature' ? goodSignature : null;
    },
  };
  const badReq = {
    body: rawBody,
    get(name) {
      return name === 'intuit-signature' ? 'bad-signature' : null;
    },
  };

  assert.deepEqual(webhook._internal.verifyIntuitSignature(goodReq), { ok: true });
  assert.equal(webhook._internal.verifyIntuitSignature(badReq).ok, false);

  if (oldToken == null) delete process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN;
  else process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = oldToken;
});
