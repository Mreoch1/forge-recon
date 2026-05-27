const test = require('node:test');
const assert = require('node:assert/strict');

const addressRoutes = require('../src/routes/api-address');
const api = addressRoutes._internal;

test('Census address normalization returns a usable Michigan street address', () => {
  const [result] = api.normalizeCensus([
    {
      addressComponents: {
        zip: '48310',
        streetName: 'DEQUINDRE',
        city: 'STERLING HEIGHTS',
        state: 'MI',
        fromAddress: '36300',
        suffixType: 'RD',
      },
    },
  ]);

  assert.equal(result.address, '36300 Dequindre Rd');
  assert.equal(result.city, 'Sterling Heights');
  assert.equal(result.state, 'MI');
  assert.equal(result.zip, '48310');
  assert.match(result.label, /36300 Dequindre Rd/);
});

test('Photon fallback ranking removes unrelated same-number streets', () => {
  const ranked = api.rankPhotonResults('36300 Dequindre Rd', [
    {
      label: '36300 Northeast 63rd Avenue  ·  La Center, WA  ·  98629',
      address: '36300 Northeast 63rd Avenue',
      city: 'La Center',
      state: 'WA',
      zip: '98629',
      country: 'US',
    },
    {
      label: '36300 Dequindre Rd  ·  Sterling Heights, MI  ·  48310',
      address: '36300 Dequindre Rd',
      city: 'Sterling Heights',
      state: 'MI',
      zip: '48310',
      country: 'US',
    },
  ]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].city, 'Sterling Heights');
  assert.equal(ranked[0].state, 'MI');
});

test('state detector treats ZIP, state abbreviations, and full state names as location context', () => {
  assert.equal(api.hasStateOrZip('36300 Dequindre Rd MI'), true);
  assert.equal(api.hasStateOrZip('36300 Dequindre Rd Michigan'), true);
  assert.equal(api.hasStateOrZip('36300 Dequindre Rd 48310'), true);
  assert.equal(api.hasStateOrZip('36300 Dequindre Rd'), false);
});
