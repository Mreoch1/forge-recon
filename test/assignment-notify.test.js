const test = require('node:test');
const assert = require('node:assert/strict');

const { notifyAssignment } = require('../src/services/assignment-notify');

test('assignment notification uses a real assigned-by display name', () => {
  const html = notifyAssignment._internal.renderAssignmentBody({
    user: { name: 'Michael Reoch' },
    entity_label: 'WO-0039-0000',
    assignedBy: { id: 1, name: 'Office' },
    deep_link: 'https://forge-recon.vercel.app/work-orders/69',
  });

  assert.match(html, /by Office/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test('assignment notification falls back cleanly for object assigned-by values', () => {
  const text = notifyAssignment._internal.buildPlainText({
    user: { name: 'Michael Reoch' },
    entity_label: 'WO-0039-0000',
    assignedBy: { id: 1 },
    deep_link: 'https://forge-recon.vercel.app/work-orders/69',
  });

  assert.match(text, /by a teammate/);
  assert.doesNotMatch(text, /\[object Object\]/);
});
