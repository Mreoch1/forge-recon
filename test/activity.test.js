const test = require('node:test');
const assert = require('node:assert/strict');

const activity = require('../src/services/activity')._internal;

test('activity humanizes audit actions for display', () => {
  assert.equal(activity.humanizeAction('create_from_estimate'), 'Create From Estimate');
  assert.equal(activity.humanizeAction('marked_sent_manually'), 'Marked Sent Manually');
});

test('activity summarizes common audit payloads', () => {
  assert.equal(activity.summarizeAudit({
    action: 'send',
    after_json: JSON.stringify({ recipient: 'test@test.com' }),
  }), 'Sent to test@test.com');

  assert.equal(activity.summarizeAudit({
    action: 'approved',
    before_json: JSON.stringify({ status: 'pending' }),
    after_json: JSON.stringify({ status: 'approved' }),
  }), 'pending -> approved');
});

test('activity turns work order notes into feed items', () => {
  const item = activity.fromNote({
    id: 1,
    body: 'Called vendor and confirmed arrival.',
    created_at: '2026-05-27T12:00:00Z',
    users: { name: 'Michael Reoch' },
  });

  assert.equal(item.kind, 'note');
  assert.equal(item.title, 'Note added');
  assert.equal(item.actor, 'Michael Reoch');
  assert.match(item.body, /confirmed arrival/);
});
