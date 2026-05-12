const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const chat = require('../src/services/ai-chat');
const aiTools = require('../src/services/ai-tools');

test('AI chat asks for required customer details before proposing create', () => {
  const intent = chat._internal.detectMutationIntent('create a customer');
  assert.equal(intent.tool, 'create_customer');

  const reply = chat._internal.buildMissingMutationReply(intent);
  assert.match(reply, /customer name/i);
});

test('AI chat resumes a guided create-customer flow from the next user message', () => {
  const intent = chat._internal.detectGuidedContinuation(
    'Michael Reoch, mike@example.com, 555-123-4567',
    [{ role: 'assistant', content: 'To create a customer, I need at least the customer name.' }]
  );

  assert.equal(intent.tool, 'create_customer');
  assert.equal(intent.args.name, 'Michael Reoch');
  assert.equal(intent.args.email, 'mike@example.com');
  assert.equal(intent.args.phone, '555-123-4567');
  assert.equal(chat._internal.buildMissingMutationReply(intent), null);
});

test('AI chat resumes create-customer flow from the live assistant wording', () => {
  const intent = chat._internal.detectGuidedContinuation(
    'Test Towers',
    [{ role: 'assistant', content: 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.' }]
  );

  assert.equal(intent.tool, 'create_customer');
  assert.equal(intent.args.name, 'Test Towers');
  assert.equal(chat._internal.buildMissingMutationReply(intent), null);
});

test('workers cannot execute privileged confirmed AI mutations', async () => {
  const result = await aiTools.executeMutation(
    'create_customer',
    { name: 'No Access Customer' },
    { role: 'worker', userId: 123, userName: 'Worker' }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /managers and admins/i);
});

test('AI chat routes work-order creation to the guided builder', () => {
  const intent = chat._internal.detectMutationIntent('I need you to help me create a work order');

  assert.equal(intent.tool, 'navigate');
  assert.equal(intent.args.path, '/work-orders/ai-create');
  assert.match(chat._internal.buildMissingMutationReply(intent), /work order/i);
  assert.equal(chat._internal.buildMissingMutationChips(intent)[0].href, '/work-orders/ai-create');
});

test('AI chat carries actual work-order details into the builder draft', () => {
  const intent = chat._internal.detectMutationIntent('create a work order for Tower 7 unit 2B leaking sink tomorrow');

  assert.equal(intent.tool, 'navigate');
  assert.match(intent.args.path, /^\/work-orders\/ai-create\?draft=/);
  assert.match(decodeURIComponent(intent.args.path), /Tower 7 unit 2B/);
});
