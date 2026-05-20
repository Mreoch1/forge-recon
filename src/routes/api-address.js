/**
 * /api/address/autocomplete — server-side proxy to Photon (free, OSM-backed).
 *
 * Why a server proxy:
 *   1. Lets us normalize the response shape so the client doesn't depend on Photon.
 *   2. Lets us swap providers (Mapbox / Google) later without touching any form view.
 *   3. Keeps API keys server-side when we eventually upgrade off Photon.
 *
 * Provider: https://photon.komoot.io/  (no API key required)
 * If quality is insufficient for production use, set ADDRESS_PROVIDER=mapbox and
 * provide MAPBOX_TOKEN to switch transparently.
 */
const express = require('express');
const router = express.Router();

// Lazy global fetch (Node 18+) — already required by other parts of the app.
const fetchFn = (typeof fetch !== 'undefined') ? fetch : null;

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
    };
  });
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
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', q);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('limit', '7');
    // Bias to US results — Photon supports `lat`/`lon`/`zoom` for bias but no hard country filter.
    // We post-filter on countrycode below.

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);

    const resp = await fetchFn(url.toString(), { signal: ctrl.signal });
    clearTimeout(timer);

    if (!resp.ok) return res.json({ results: [] });
    const json = await resp.json();
    const filtered = (json.features || []).filter((f) => {
      const cc = (f.properties && f.properties.countrycode) || '';
      return !cc || cc.toLowerCase() === 'us';
    });
    return res.json({ results: normalizePhoton(filtered).slice(0, 5) });
  } catch (_err) {
    // Network / timeout / abort — fail soft, UI keeps working as plain text input.
    return res.json({ results: [] });
  }
});

module.exports = router;
