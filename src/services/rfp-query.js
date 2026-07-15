function flattenQueryValues(value) {
  if (Array.isArray(value)) return value.flatMap(flattenQueryValues);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort((a, b) => {
        const aNumber = Number(a);
        const bNumber = Number(b);
        if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
        return a.localeCompare(b);
      })
      .flatMap(key => flattenQueryValues(value[key]));
  }
  return [value];
}

function selectedBidRequestItemIds(queryValue) {
  return flattenQueryValues(queryValue)
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim())
    .filter(value => /^\d+$/.test(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

module.exports = { selectedBidRequestItemIds };
