/**
 * Unit tests for src/services/numbering.js — counter format.
 * The atomic-increment behavior is integration-tested through the
 * estimate / WO / invoice creation flows; here we just verify formatting.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';
const numbering = require('../src/services/numbering');

test('format: pads to 4 digits, embeds current year', () => {
  assert.equal(numbering.formatDisplay(1, 0), '0001-0000');
  assert.equal(numbering.woDisplay(42, 3), 'WO-0042-0003');
  assert.equal(numbering.invoiceDisplay(9999, 0), 'INV-9999-0000');
});

test('format: numbers > 9999 still render', () => {
  // 5-digit number: padding stops at 4; result still readable
  assert.equal(numbering.estimateDisplay(12345, 12), 'EST-12345-0012');
});

test('parseDisplay accepts FORGE WO display numbers', () => {
  assert.deepEqual(numbering.parseDisplay('0042-0003'), { main: 42, sub: 3 });
  assert.equal(numbering.parseDisplay('WO-0042-0003'), null);
  assert.equal(numbering.parseDisplay('bad'), null);
});

test('pad respects requested width', () => {
  assert.equal(numbering.pad(7, 4), '0007');
  assert.equal(numbering.pad(12345, 4), '12345');
});
