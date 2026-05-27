/**
 * /api/address/autocomplete — server-side address suggestions.
 *
 * Why a server proxy:
 *   1. Lets us normalize the response shape so the client doesn't depend on a provider.
 *   2. Lets us combine exact US street matches with broader fallback search.
 *   3. Keeps API keys server-side if we eventually upgrade to a paid provider.
 *
 * Exact provider: US Census Geocoder (free, no key).
 * Fallback provider: Photon (free, OSM-backed, no key).
 */
const express = require('express');
const router = express.Router();

// Lazy global fetch (Node 18+) — already required by other parts of the app.
const fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
const DEFAULT_STATES = (process.env.ADDRESS_DEFAULT_STATES || 'MI,OH')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const ADDRESS_BIAS_LAT = process.env.ADDRESS_BIAS_LAT || '42.3314'; // Detroit
const ADDRESS_BIAS_LON = process.env.ADDRESS_BIAS_LON || '-83.0458';

// US state name → 2-letter code. Photon returns full names; forms expect abbreviations.
const US_STATES = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
  'Colorado':'CO','Connecticut':'CT','Delaware':'DE','District of Columbia':'DC',
  'Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID','Illinois':'IL',
  'Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA',
  'Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN',
  'Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV',
  'New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
  'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR',
  'Pennsylvania':'PA','Puerto Rico':'PR','Rhode Island':'RI','South Carolina':'SC',
  'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT',
  'Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
};

function stateAbbrev(name) {
  if (!name) return '';
  if (name.length === 2) return name.toUpperCase();
  return US_STATES[name] || '';
}

const STATE_NAMES = Object.keys(US_STATES).map((s) => s.toLowerCase());
const STATE_ABBREVS = new Set(Object.values(US_STATES));
const STREET_STOPWORDS = new Set([
  'rd', 'road', 'st', 'street', 'ave', 'avenue', 'blvd', 'boulevard', 'dr', 'drive',
  'ln', 'lane', 'ct', 'court', 'cir', 'circle', 'pl', 'place', 'pkwy', 'parkway',
  'hwy', 'highway', 'way', 'mi', 'oh', 'michigan', 'ohio'
]);

function hasStateOrZip(q) {
  const raw = String(q || '');
  const lower = raw.toLowerCase();
  const fiveDigitParts = raw.match(/\b\d{5}(?:-\d{4})?\b/g) || [];
  const firstNumber = (raw.match(/\b\d{2,6}\b/) || [])[0] || '';
  if (fiveDigitParts.some((part) => part.slice(0, 5) !== firstNumber)) return true;
  const abbrevs = raw.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
  if (abbrevs.some((abbr) => STATE_ABBREVS.has(abbr))) return true;
  return STATE_NAMES.some((state) => lower.includes(state));
}

function streetTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !/^\d+$/.test(t) && !STREET_STOPWORDS.has(t));
}

function normalizeStreetName(parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function normalizeCensus(matches) {
  return (matches || []).map((m) => {
    const c = m.addressComponents || {};
    const street = normalizeStreetName([
      c.fromAddress,
      c.preDirection,
      c.preType,
      c.streetName,
      c.suffixType,
      c.suffixDirection
    ]).replace(/\b([A-Z]+)\b/g, (word) => {
      const suffixes = { ROAD: 'Rd', RD: 'Rd', STREET: 'St', ST: 'St', AVENUE: 'Ave', AVE: 'Ave', DRIVE: 'Dr', DR: 'Dr' };
      return suffixes[word] || (word.charAt(0) + word.slice(1).toLowerCase());
    });
    const city = c.city ? String(c.city).toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) : '';
    const state = c.state || '';
    const zip = c.zip || '';
    return {
      label: [street, [city, state].filter(Boolean).join(', '), zip].filter(Boolean).join('  ·  '),
      address: street,
      city,
      state,
      zip,
      country: 'US',
      source: 'census'
    };
  });
}

function normalizePhoton(features) {
  return (features || []).map((f) => {
    const p = f.properties || {};
    const street = [p.housenumber, p.street].filter(Boolean).join(' ').trim() || p.name || '';
    const city = p.city || p.town || p.village || p.locality || p.county || '';
    const state = stateAbbrev(p.state || p.region || '');
    const zip = p.postcode || '';
    // Human label for dropdown line
    const labelParts = [
      street,
      [city, state].filter(Boolean).join(', '),
      zip
    ].filter(Boolean);
    return {
      label: labelParts.join('  ·  ') || (p.name || ''),
      address: street,
      city,
      state,
      zip,
      country: p.countrycode ? p.countrycode.toUpperCase() : '',
      source: 'photon'
    };
  });
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  (results || []).forEach((r) => {
    const key = [r.address, r.city, r.state, r.zip].map((v) => String(v || '').toLowerCase()).join('|');
    if (!key.replace(/\|/g, '') || seen.has(key)) return;
    seen.add(key);
    out.push(r);
  });
  return out;
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url.toString(), { signal: ctrl.signal, headers: { 'User-Agent': 'FORGE address autocomplete' } });
    if (!resp.ok) return null;
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function censusSuggestions(q) {
  const variants = [q];
  if (!hasStateOrZip(q)) {
    DEFAULT_STATES.forEach((state) => variants.push(`${q} ${state}`));
  }

  const all = [];
  for (const address of variants) {
    const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('format', 'json');
    const json = await fetchJson(url, 2500);
    all.push(...normalizeCensus(json?.result?.addressMatches || []));
    if (all.length >= 5) break;
  }
  return dedupeResults(all);
}

function rankPhotonResults(q, results) {
  const queryTokens = streetTokens(q);
  const queryHouse = (String(q).match(/\b\d{2,6}\b/) || [])[0] || '';
  return (results || [])
    .filter((r) => {
      if (r.country && r.country !== 'US') return false;
      if (!queryTokens.length) return true;
      const candidate = streetTokens([r.address, r.label].filter(Boolean).join(' '));
      return queryTokens.some((t) => candidate.includes(t));
    })
    .map((r) => {
      const label = `${r.address || ''} ${r.label || ''}`.toLowerCase();
      let score = 0;
      if (DEFAULT_STATES.includes(r.state)) score += 40;
      if (queryHouse && label.includes(queryHouse)) score += 25;
      queryTokens.forEach((t) => { if (label.includes(t)) score += 12; });
      if (r.address) score += 5;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

async function photonSuggestions(q) {
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', q);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('limit', '10');
  url.searchParams.set('lat', ADDRESS_BIAS_LAT);
  url.searchParams.set('lon', ADDRESS_BIAS_LON);
  url.searchParams.set('zoom', '10');

  const json = await fetchJson(url, 3500);
  const filtered = (json?.features || []).filter((f) => {
    const cc = (f.properties && f.properties.countrycode) || '';
    return !cc || cc.toLowerCase() === 'us';
  });
  return rankPhotonResults(q, normalizePhoton(filtered));
}

/**
 * GET /api/address/autocomplete?q=<query>
 * Returns { results: [{ label, address, city, state, zip, country }, ...] }
 *
 * On failure returns 200 with empty results so the UI gracefully degrades.
 */
router.get('/autocomplete', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 3) return res.json({ results: [] });

  if (!fetchFn) {
    // Older Node — should not happen but be safe.
    return res.json({ results: [] });
  }

  try {
    const census = await censusSuggestions(q);
    if (census.length) return res.json({ results: census.slice(0, 5) });

    const photon = await photonSuggestions(q);
    return res.json({ results: dedupeResults(photon).slice(0, 5) });
  } catch (_err) {
    // Network / timeout / abort — fail soft, UI keeps working as plain text input.
    return res.json({ results: [] });
  }
});

router._internal = {
  censusSuggestions,
  hasStateOrZip,
  normalizeCensus,
  normalizePhoton,
  photonSuggestions,
  rankPhotonResults,
  streetTokens,
};

module.exports = router;
