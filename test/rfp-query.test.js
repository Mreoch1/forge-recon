const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectedBidRequestItemIds } = require('../src/services/rfp-query');

test('selected bid request IDs support repeated query arrays', () => {
  assert.deepEqual(selectedBidRequestItemIds(['338', '339', '340']), ['338', '339', '340']);
});

test('selected bid request IDs support Express numbered query objects', () => {
  assert.deepEqual(
    selectedBidRequestItemIds({ 2: '340', 0: '338', 1: '339', 3: ['341', '342'] }),
    ['338', '339', '340', '341', '342']
  );
});

test('selected bid request IDs split comma values and reject malformed IDs', () => {
  assert.deepEqual(
    selectedBidRequestItemIds(['338, 339', '[object Object]', 'abc', '338', '', null]),
    ['338', '339']
  );
});
