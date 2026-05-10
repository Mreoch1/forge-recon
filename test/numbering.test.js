/**
 * Unit tests for src/services/numbering.js — counter format.
 * The atomic-increment behavior is integration-tested through the
 * estimate / WO / invoice creation flows; here we just verify formatting.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const numbering = require('../src/services/numbering');

test('format: pads to 4 digits, embeds current year', () => {
  const year = new Date().getFullYear();
  assert.equal(numbering._format('EST', 1), `EST-${year}-0001`);
  assert.equal(numbering._format('WO', 42), `WO-${year}-0042`);
  assert.equal(numbering._format('INV', 9999), `INV-${year}-9999`);
});

test('format: numbers > 9999 still render', () => {
  const year = new Date().getFullYear();
  // 5-digit number: padding stops at 4; result still readable
  const out = numbering._format('EST', 12345);
  assert.equal(out, `EST-${year}-12345`);
});

test('format: respects prefix exactly', () => {
  const year = new Date().getFullYear();
  assert.equal(numbering._format('CUSTOM', 7), `CUSTOM-${year}-0007`);
});

test('_nextNumber rejects unknown field', () => {
  assert.throws(() => numbering._nextNumber('next_bogus_number'),
    /Invalid numbering field/);
});
