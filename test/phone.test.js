const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUsPhone, emptyToNullFormattedPhone } = require('../src/services/phone');

test('formatUsPhone formats 10 digit US phone numbers', () => {
  assert.equal(formatUsPhone('7346936664'), '(734) 693-6664');
  assert.equal(formatUsPhone('734-693-6664'), '(734) 693-6664');
  assert.equal(formatUsPhone('+1 (734) 693-6664'), '(734) 693-6664');
});

test('formatUsPhone leaves non-standard phone numbers alone', () => {
  assert.equal(formatUsPhone('ext 12'), 'ext 12');
  assert.equal(formatUsPhone('555'), '555');
});

test('emptyToNullFormattedPhone returns null for blank values', () => {
  assert.equal(emptyToNullFormattedPhone(''), null);
  assert.equal(emptyToNullFormattedPhone('   '), null);
});
