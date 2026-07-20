'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateApprovedRfpFinancials } = require('../src/services/rfp-approved-rollup');

test('approved RFP financials count sub-lines instead of their parent rollup', () => {
  const totals = aggregateApprovedRfpFinancials([
    { id: 10, parent_line_item_id: null, approved: true, total_cost: 300, total_with_markup: 360 },
    { id: 11, parent_line_item_id: 10, approved: true, total_cost: 100, total_with_markup: 120 },
    { id: 12, parent_line_item_id: 10, approved: true, total_cost: 200, total_with_markup: 240 },
  ]);

  assert.deepEqual(totals, { cost: 300, value: 360, lineCount: 2 });
});

test('approved RFP financials include approved children and approved standalone rows only', () => {
  const totals = aggregateApprovedRfpFinancials([
    { id: 20, parent_line_item_id: null, approved: true, total_cost: 999, total_with_markup: 1199 },
    { id: 21, parent_line_item_id: 20, approved: true, total_cost: 125, total_with_markup: 150 },
    { id: 22, parent_line_item_id: 20, approved: false, total_cost: 225, total_with_markup: 270 },
    { id: 30, parent_line_item_id: null, approved: true, total_cost: 50, total_with_markup: 60 },
    { id: 40, parent_line_item_id: null, approved: false, total_cost: 75, total_with_markup: 90 },
  ]);

  assert.deepEqual(totals, { cost: 175, value: 210, lineCount: 2 });
});

test('an approved parent contributes nothing when it has only unapproved children', () => {
  const totals = aggregateApprovedRfpFinancials([
    { id: 50, parent_line_item_id: null, approved: true, total_cost: 500, total_with_markup: 600 },
    { id: 51, parent_line_item_id: 50, approved: false, total_cost: 500, total_with_markup: 600 },
  ]);

  assert.deepEqual(totals, { cost: 0, value: 0, lineCount: 0 });
});
