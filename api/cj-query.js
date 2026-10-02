'use strict';

function buildCjQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null && item !== '') params.append(key, String(item));
    }
  }
  return params.toString();
}

module.exports = { buildCjQuery };
