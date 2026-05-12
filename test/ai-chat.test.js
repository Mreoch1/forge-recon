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

test('workers cannot execute privileged confirmed AI mutations', async () => {
  const result = await aiTools.executeMutation(
    'create_customer',
    { name: 'No Access Customer' },
    { role: 'worker', userId: 123, userName: 'Worker' }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /managers and admins/i);
});
