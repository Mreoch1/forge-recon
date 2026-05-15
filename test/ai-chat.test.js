const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const chat = require('../src/services/ai-chat');
const aiTools = require('../src/services/ai-tools');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(chat._internal.buildMissingMutationReply(intent), /service address/i);
});

test('AI chat resumes create-customer flow from the live assistant wording', () => {
  const intent = chat._internal.detectGuidedContinuation(
    'Test Towers',
    [{ role: 'assistant', content: 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.' }]
  );

  assert.equal(intent.tool, 'create_customer');
  assert.equal(intent.args.name, 'Test Towers');
  assert.match(chat._internal.buildMissingMutationReply(intent), /Do you know the email/i);
});

test('AI chat waits for optional customer intake fields before confirmation', () => {
  const firstIntent = chat._internal.detectGuidedContinuation(
    'Test Towers',
    [{ role: 'assistant', content: 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.' }]
  );
  const intakeReply = chat._internal.buildMissingMutationReply(firstIntent);

  assert.match(intakeReply, /email/);
  assert.match(intakeReply, /phone/);
  assert.match(intakeReply, /billing email or billing address/);
  assert.match(intakeReply, /contact or manager name/);
});

test('AI chat creates customer with known info after user says not sure', () => {
  const intent = chat._internal.detectGuidedContinuation(
    'not sure',
    [
      { role: 'assistant', content: 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.' },
      { role: 'user', content: 'Test Towers' },
      { role: 'assistant', content: 'Got the customer name for Test Towers. Do you know the email, phone, service address, billing email or billing address, contact or manager name? Send whatever you have, or say "not sure" and I will create the customer with what we have.' }
    ]
  );

  assert.equal(intent.tool, 'create_customer');
  assert.equal(intent.args.name, 'Test Towers');
  assert.equal(intent.args._customer_skip_missing, true);
  assert.equal(chat._internal.buildMissingMutationReply(intent), null);
});

test('AI chat merges customer details across intake turns', () => {
  const intent = chat._internal.detectGuidedContinuation(
    'phone is 555-123-4567, contact is Sarah Manager',
    [
      { role: 'assistant', content: 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.' },
      { role: 'user', content: 'Test Towers' },
      { role: 'assistant', content: 'Got the customer name for Test Towers. Do you know the email, phone, service address, billing email or billing address, contact or manager name? Send whatever you have, or say "not sure" and I will create the customer with what we have.' }
    ]
  );

  assert.equal(intent.args.name, 'Test Towers');
  assert.equal(intent.args.phone, '555-123-4567');
  assert.equal(intent.args.contact_name, 'Sarah Manager');
  assert.match(chat._internal.buildMissingMutationReply(intent), /email/);
});

test('AI chat resolves active create-customer continuations deterministically', () => {
  const intent = chat._internal.resolveMutationIntent(
    'phone is 555-123-4567, contact is Sarah Manager',
    [
      { role: 'assistant', content: 'Absolutely. I can create the customer in FORGE. Give me the customer name first. You can include email, phone, billing email, and address in the same message if you have them.' },
      { role: 'user', content: 'Test Towers' },
      { role: 'assistant', content: 'Got the customer name for Test Towers. Do you know the email, phone, service address, billing email or billing address, contact or manager name? Send whatever you have, or say "not sure" and I will create the customer with what we have.' }
    ],
    {},
    'create_customer'
  );

  assert.equal(intent.tool, 'create_customer');
  assert.equal(intent.args.name, 'Test Towers');
  assert.equal(intent.args.phone, '555-123-4567');
  assert.equal(intent.args.contact_name, 'Sarah Manager');
});

test('AI chat does not reclassify a different intent while an active flow is locked', () => {
  const intent = chat._internal.resolveMutationIntent(
    'create a work order for Test Towers',
    [],
    {},
    'create_customer'
  );

  assert.equal(intent, null);
  assert.equal(chat._internal.isCancelFlowMessage('never mind'), true);
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

test('worker customer scope includes current open and closed work order statuses', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-tools.js'), 'utf8');

  assert.match(
    source,
    /\.in\('status', \['open', 'scheduled', 'in_progress', 'closed', 'complete'\]\)/
  );
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

test('AI chat keeps hierarchy stack alive when user accepts parent creation', () => {
  const response = chat._internal.handlePendingParentResponse(
    'yes',
    [{ role: 'assistant', content: 'I don\'t have a customer named "New Tower" on file. Want me to create them first? (yes / no / different name)' }],
    [{
      tool: 'navigate',
      args: { path: '/work-orders/ai-create?draft=create%20work%20order%20for%20New%20Tower' },
      entityType: 'work_order',
      parentName: 'New Tower',
      pendingParent: 'customer',
    }],
    { userId: 1 },
    Date.now()
  );

  assert.equal(response.active_intent, 'create_customer');
  assert.equal(response.entity_stack.length, 1);
  assert.equal(response.entity_stack[0].pendingParent, 'customer');
  assert.match(response.reply, /New Tower/i);
});

test('AI chat gives hierarchy guidance for direct invoice creation requests', () => {
  const reply = chat._internal.buildCreateChildGuidance('Create an invoice for New Tower');

  assert.match(reply, /approved estimate/i);
  assert.match(reply, /work order/i);
});

test('AI chat does not propose nonexistent invoice creation tool', () => {
  const intent = chat._internal.detectMutationIntent('create an invoice for New Tower estimate 5');
  const reply = chat._internal.buildMissingMutationReply(intent);
  const chips = chat._internal.buildMissingMutationChips(intent);

  assert.equal(intent.tool, 'create_invoice');
  assert.match(reply, /Open EST-5/i);
  assert.equal(chips[0].href, '/estimates/5');
});
