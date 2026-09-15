const { CITIES, COUNTIES } = require('../constants');

function toRad(deg) { return deg * Math.PI / 180; }

// Distance between two lat/lng points, in miles.
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function lookupIn(list, norm) {
  const exact = list.find(c => c.name.toLowerCase() === norm);
  if (exact) return exact;
  return list.find(c => norm.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(norm)) || null;
}

// Looks up known coordinates for a city OR county name typed/selected by a user.
// Checks the county list first (since that's what homeowners now enter), then
// falls back to the city list (used by contractors). Matches exactly first,
// then a loose substring match so close variations still work. Returns null for
// locations outside the bundled data - those simply can't be radius-filtered
// precisely (see README).
function findCityCoords(name) {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  return lookupIn(COUNTIES, norm) || lookupIn(CITIES, norm);
}

module.exports = { distanceMiles, findCityCoords };
