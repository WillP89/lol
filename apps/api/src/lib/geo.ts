/**
 * Shared great-circle distance math. Was a private copy inside services/match.ts (Crew radius
 * scoring); pulled out here so Explore's new radius search (services/explore.ts) can use the
 * exact same calculation rather than a second hand-rolled version drifting from it over time.
 */

const EARTH_RADIUS_MILES = 3958.8;
const EARTH_RADIUS_KM = 6371.0;

function haversine(lat1: number, lng1: number, lat2: number, lng2: number, earthRadius: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Great-circle distance in miles — UK convention (brief: "miles not raw coordinates"), used by
 * the Crew match/recommendation engines' travel-radius scoring. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversine(lat1, lng1, lat2, lng2, EARTH_RADIUS_MILES);
}

/** Great-circle distance in kilometres — used by Explore's radius search, since the UI's radius
 * control (this directive's own ask: "extend the map radius") is framed in km alongside the
 * postcode/area picker, a more natural unit for "how far are you willing to search" than miles
 * when the UI also shows a distance-widening slider rather than a fixed brief-specified figure. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversine(lat1, lng1, lat2, lng2, EARTH_RADIUS_KM);
}
