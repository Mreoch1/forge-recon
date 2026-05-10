/**
 * Unit tests for src/services/calculations.js — money-safe math.
 * Run with `npm test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../src/services/calculations');

test('round2: rounds to 2 decimals', () => {
  assert.equal(calc.round2(1.005), 1.01);
  assert.equal(calc.round2(1.004), 1.00);
  assert.equal(calc.round2(0), 0);
  assert.equal(calc.round2(0.1 + 0.2), 0.30);
});

test('lineTotal: simple multiply', () => {
  assert.equal(calc.lineTotal({ quantity: 3, unit_price: 10 }), 30);
  assert.equal(calc.lineTotal({ quantity: 1.5, unit_price: 200 }), 300);
});

test('lineTotal: zero / missing', () => {
  assert.equal(calc.lineTotal({ quantity: 0, unit_price: 100 }), 0);
  assert.equal(calc.lineTotal({ quantity: 5, unit_price: 0 }), 0);
  assert.equal(calc.lineTotal({}), 0);
  assert.equal(calc.lineTotal({ quantity: 'x', unit_price: 'y' }), 0);
});

test('lineTotal: rounds to 2 decimals', () => {
  // 0.333 * 3 = 0.999 → rounds to 1.00
  assert.equal(calc.lineTotal({ quantity: 3, unit_price: 0.333 }), 1.00);
});

test('totals: empty lines', () => {
  const t = calc.totals([], 0);
  assert.equal(t.subtotal, 0);
  assert.equal(t.taxAmount, 0);
  assert.equal(t.total, 0);
});

test('totals: 7.5% on $21,500 = 1612.50 / 23112.50', () => {
  const lines = [
    { quantity: 1, unit_price: 2500 },
    { quantity: 1, unit_price: 18000 },
    { quantity: 8, unit_price: 125 },
  ];
  const t = calc.totals(lines, 7.5);
  assert.equal(t.subtotal, 21500);
  assert.equal(t.taxAmount, 1612.50);
  assert.equal(t.total, 23112.50);
});

test('totals: zero tax rate', () => {
  const lines = [{ quantity: 2, unit_price: 100 }];
  const t = calc.totals(lines, 0);
  assert.equal(t.subtotal, 200);
  assert.equal(t.taxAmount, 0);
  assert.equal(t.total, 200);
});

test('totals: invalid tax_rate treated as 0', () => {
  const lines = [{ quantity: 1, unit_price: 100 }];
  assert.equal(calc.totals(lines, 'abc').taxAmount, 0);
  assert.equal(calc.totals(lines, undefined).taxAmount, 0);
  assert.equal(calc.totals(lines, null).taxAmount, 0);
});

test('totals: handles non-array gracefully', () => {
  const t = calc.totals(null, 7.5);
  assert.equal(t.subtotal, 0);
  assert.equal(t.taxAmount, 0);
  assert.equal(t.total, 0);
});

test('totals: large quantities + small unit prices', () => {
  // Stress test the floating point — 100 lines of $1.50 each
  const lines = Array.from({ length: 100 }, () => ({ quantity: 1, unit_price: 1.50 }));
  const t = calc.totals(lines, 8);
  assert.equal(t.subtotal, 150);
  assert.equal(t.taxAmount, 12);
  assert.equal(t.total, 162);
});
