const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyRadiusFilter,
  lookupCoordinate,
  parseLocationInput,
} = require('../src/services/location-radius');

test('parseLocationInput accepts city state and comma formats', () => {
  assert.deepEqual(parseLocationInput('Farmington MI'), { city: 'Farmington', state: 'MI' });
  assert.deepEqual(parseLocationInput('Farmington MI.'), { city: 'Farmington', state: 'MI' });
  assert.deepEqual(parseLocationInput('Farmington, Michigan'), { city: 'Farmington', state: 'MI' });
  assert.deepEqual(parseLocationInput('Farmington'), { city: 'Farmington', state: 'MI' });
});

test('lookupCoordinate knows Farmington and common Michigan contractor cities', () => {
  assert.ok(lookupCoordinate('Farmington', 'MI'));
  assert.ok(lookupCoordinate('Macomb', 'MI'));
  assert.ok(lookupCoordinate('Lapeer', 'MI'));
  assert.ok(lookupCoordinate('Mount Morris', 'MI'));
  assert.ok(lookupCoordinate('Lake Orion', 'MI'));
  assert.ok(lookupCoordinate('Wixom', 'MI'));
  assert.ok(lookupCoordinate('Ira', 'MI'));
  assert.ok(lookupCoordinate('Muskegon', 'MI'));
});

test('applyRadiusFilter filters and sorts intakes by distance', () => {
  const rows = [
    { id: 1, company_name: 'Macomb Contractor', city: 'Macomb', state: 'MI' },
    { id: 2, company_name: 'Grand Rapids Contractor', city: 'Grand Rapids', state: 'MI' },
    { id: 3, company_name: 'Linden Contractor', city: 'Linden', state: 'MI' },
  ];

  const result = applyRadiusFilter(rows, 'Farmington MI', 80);

  assert.equal(result.warning, '');
  assert.deepEqual(result.rows.map(row => row.company_name), ['Macomb Contractor', 'Linden Contractor']);
  assert.ok(result.rows.every(row => row.distance_miles <= 80));
});

test('applyRadiusFilter returns a warning for unknown radius centers', () => {
  const result = applyRadiusFilter([], 'Notacity MI', 80);
  assert.match(result.warning, /do not have coordinates/);
});

test('applyRadiusFilter finds west Michigan contractors near Muskegon', () => {
  const rows = [
    { id: 1, company_name: 'Jenison Electric', city: 'Jenison', state: 'MI' },
    { id: 2, company_name: 'Macomb Electric', city: 'Macomb', state: 'MI' },
  ];

  const result = applyRadiusFilter(rows, 'muskegon', 100);

  assert.equal(result.warning, '');
  assert.deepEqual(result.rows.map(row => row.company_name), ['Jenison Electric']);
  assert.ok(result.rows[0].distance_miles < 50);
});
