const STATE_ALIASES = {
  michigan: 'MI',
  mi: 'MI',
};

const CITY_COORDS = {
  'ann arbor|MI': { lat: 42.2808, lon: -83.7430 },
  'auburn hills|MI': { lat: 42.6875, lon: -83.2341 },
  'bay city|MI': { lat: 43.5945, lon: -83.8889 },
  'birmingham|MI': { lat: 42.5467, lon: -83.2113 },
  'bridgeport|MI': { lat: 43.3595, lon: -83.8816 },
  'bridgport|MI': { lat: 43.3595, lon: -83.8816 },
  'brighton|MI': { lat: 42.5295, lon: -83.7802 },
  'canton|MI': { lat: 42.3086, lon: -83.4822 },
  'clio|MI': { lat: 43.1775, lon: -83.7341 },
  'dearborn|MI': { lat: 42.3223, lon: -83.1763 },
  'detroit|MI': { lat: 42.3314, lon: -83.0458 },
  'farmington|MI': { lat: 42.4645, lon: -83.3763 },
  'farmington hills|MI': { lat: 42.4989, lon: -83.3677 },
  'flint|MI': { lat: 43.0125, lon: -83.6875 },
  'garden city|MI': { lat: 42.3256, lon: -83.3310 },
  'grand rapids|MI': { lat: 42.9634, lon: -85.6681 },
  'ira|MI': { lat: 42.6906, lon: -82.6605 },
  'jenison|MI': { lat: 42.9073, lon: -85.7919 },
  'lake orion|MI': { lat: 42.7845, lon: -83.2397 },
  'lapeer|MI': { lat: 43.0514, lon: -83.3188 },
  'linden|MI': { lat: 42.8145, lon: -83.7825 },
  'livonia|MI': { lat: 42.3684, lon: -83.3527 },
  'macomb|MI': { lat: 42.7009, lon: -82.9599 },
  'madison heights|MI': { lat: 42.4859, lon: -83.1052 },
  'mount morris|MI': { lat: 43.1186, lon: -83.6944 },
  'mt morris|MI': { lat: 43.1186, lon: -83.6944 },
  'novi|MI': { lat: 42.4806, lon: -83.4755 },
  'oak park|MI': { lat: 42.4595, lon: -83.1827 },
  'pontiac|MI': { lat: 42.6389, lon: -83.2911 },
  'redford|MI': { lat: 42.3834, lon: -83.2966 },
  'rochester hills|MI': { lat: 42.6584, lon: -83.1499 },
  'royal oak|MI': { lat: 42.4895, lon: -83.1446 },
  'saginaw|MI': { lat: 43.4195, lon: -83.9508 },
  'southfield|MI': { lat: 42.4734, lon: -83.2219 },
  'sterling heights|MI': { lat: 42.5803, lon: -83.0302 },
  'troy|MI': { lat: 42.6064, lon: -83.1498 },
  'warren|MI': { lat: 42.5145, lon: -83.0147 },
  'waterford|MI': { lat: 42.6930, lon: -83.4118 },
  'westland|MI': { lat: 42.3242, lon: -83.4002 },
  'wixom|MI': { lat: 42.5248, lon: -83.5363 },
};

function normalizeCity(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

function normalizeState(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return STATE_ALIASES[key] || key.toUpperCase();
}

function coordinateKey(city, state) {
  const normalizedCity = normalizeCity(city);
  const normalizedState = normalizeState(state);
  if (!normalizedCity || !normalizedState) return '';
  return `${normalizedCity}|${normalizedState}`;
}

function lookupCoordinate(city, state) {
  return CITY_COORDS[coordinateKey(city, state)] || null;
}

function parseLocationInput(input, fallbackState = '') {
  const raw = String(input || '').trim();
  if (!raw) return { city: '', state: normalizeState(fallbackState || '') };

  const commaParts = raw.split(',').map(part => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    return { city: commaParts[0], state: normalizeState(commaParts[1]) };
  }

  const words = raw.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  const state = normalizeState(last);
  if (state.length === 2 && words.length > 1) {
    return { city: words.slice(0, -1).join(' '), state };
  }

  return { city: raw, state: normalizeState(fallbackState || 'MI') };
}

function milesBetween(a, b) {
  const earthRadiusMiles = 3958.8;
  const toRadians = degrees => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function applyRadiusFilter(rows, locationInput, radiusMiles, fallbackState = 'MI') {
  const radius = Number(radiusMiles);
  if (!locationInput || !Number.isFinite(radius) || radius <= 0) {
    return { rows, center: null, radius: null, warning: '' };
  }

  const location = parseLocationInput(locationInput, fallbackState);
  const center = lookupCoordinate(location.city, location.state);
  if (!center) {
    return {
      rows: [],
      center: location,
      radius,
      warning: `We do not have coordinates for ${[location.city, location.state].filter(Boolean).join(', ')} yet.`,
    };
  }

  const filtered = rows
    .map((row) => {
      const point = lookupCoordinate(row.city, row.state || location.state);
      if (!point) return { ...row, distance_miles: null };
      return { ...row, distance_miles: milesBetween(center, point) };
    })
    .filter(row => row.distance_miles !== null && row.distance_miles <= radius)
    .sort((a, b) => a.distance_miles - b.distance_miles || String(a.company_name || '').localeCompare(String(b.company_name || '')));

  return { rows: filtered, center: location, radius, warning: '' };
}

module.exports = {
  applyRadiusFilter,
  lookupCoordinate,
  milesBetween,
  parseLocationInput,
};
