/**
 * A curated, static gazetteer of real UK towns/cities — public-domain geographic facts (name +
 * approximate centre coordinates), not fabricated event inventory. Exists so location search
 * ("Where are you based?", Explore's city switcher) works UK-wide without depending on a live
 * geocoding API this environment can't reach (the egress proxy blocks it) — see
 * docs/DECISIONS.md#uk-wide-location for why this exists instead of a real geocoder call, and
 * what replacing it with one (Google Places / Mapbox / OS Names API) would take.
 *
 * Deliberately NOT exhaustive — every UK postcode area is out of scope for a beta. Covers major
 * cities plus the Staffordshire towns this milestone's actual test group is based around.
 */
import { haversineKm } from '../lib/geo';

export interface UkPlace {
  name: string;
  region: string;
  lat: number;
  lng: number;
}

export const UK_PLACES: UkPlace[] = [
  // Staffordshire & the immediate test area
  { name: 'Stafford', region: 'Staffordshire', lat: 52.8062, lng: -2.1169 },
  { name: 'Stone', region: 'Staffordshire', lat: 52.9046, lng: -2.1548 },
  { name: 'Cannock', region: 'Staffordshire', lat: 52.6913, lng: -2.0303 },
  { name: 'Stoke-on-Trent', region: 'Staffordshire', lat: 53.0027, lng: -2.1794 },
  { name: 'Newcastle-under-Lyme', region: 'Staffordshire', lat: 53.0114, lng: -2.2277 },
  { name: 'Lichfield', region: 'Staffordshire', lat: 52.6828, lng: -1.8285 },
  { name: 'Tamworth', region: 'Staffordshire', lat: 52.6335, lng: -1.6953 },
  { name: 'Rugeley', region: 'Staffordshire', lat: 52.7606, lng: -1.9354 },
  { name: 'Uttoxeter', region: 'Staffordshire', lat: 52.8992, lng: -1.8637 },
  { name: 'Trentham', region: 'Staffordshire', lat: 52.9738, lng: -2.1866 },
  { name: 'Burton upon Trent', region: 'Staffordshire', lat: 52.8019, lng: -1.6396 },
  { name: 'Telford', region: 'Shropshire', lat: 52.6784, lng: -2.4453 },
  { name: 'Shrewsbury', region: 'Shropshire', lat: 52.7069, lng: -2.7527 },
  // Major cities, roughly north to south
  { name: 'Edinburgh', region: 'Scotland', lat: 55.9533, lng: -3.1883 },
  { name: 'Glasgow', region: 'Scotland', lat: 55.8642, lng: -4.2518 },
  { name: 'Aberdeen', region: 'Scotland', lat: 57.1497, lng: -2.0943 },
  { name: 'Dundee', region: 'Scotland', lat: 56.462, lng: -2.9707 },
  { name: 'Newcastle upon Tyne', region: 'Tyne and Wear', lat: 54.9783, lng: -1.6178 },
  { name: 'Sunderland', region: 'Tyne and Wear', lat: 54.9069, lng: -1.3838 },
  { name: 'Carlisle', region: 'Cumbria', lat: 54.8951, lng: -2.9382 },
  { name: 'Leeds', region: 'West Yorkshire', lat: 53.8008, lng: -1.5491 },
  { name: 'Bradford', region: 'West Yorkshire', lat: 53.7938, lng: -1.7524 },
  { name: 'Sheffield', region: 'South Yorkshire', lat: 53.3811, lng: -1.4701 },
  { name: 'York', region: 'North Yorkshire', lat: 53.9599, lng: -1.0873 },
  { name: 'Hull', region: 'East Yorkshire', lat: 53.7676, lng: -0.3274 },
  { name: 'Manchester', region: 'Greater Manchester', lat: 53.4808, lng: -2.2426 },
  { name: 'Salford', region: 'Greater Manchester', lat: 53.4875, lng: -2.2901 },
  { name: 'Liverpool', region: 'Merseyside', lat: 53.4084, lng: -2.9916 },
  { name: 'Preston', region: 'Lancashire', lat: 53.7632, lng: -2.7031 },
  { name: 'Blackpool', region: 'Lancashire', lat: 53.8175, lng: -3.0357 },
  { name: 'Chester', region: 'Cheshire', lat: 53.1934, lng: -2.8931 },
  { name: 'Wolverhampton', region: 'West Midlands', lat: 52.5862, lng: -2.1288 },
  { name: 'Birmingham', region: 'West Midlands', lat: 52.4862, lng: -1.8904 },
  { name: 'Coventry', region: 'West Midlands', lat: 52.4068, lng: -1.5197 },
  { name: 'Nottingham', region: 'Nottinghamshire', lat: 52.9548, lng: -1.1581 },
  { name: 'Derby', region: 'Derbyshire', lat: 52.9225, lng: -1.4746 },
  { name: 'Leicester', region: 'Leicestershire', lat: 52.6369, lng: -1.1398 },
  { name: 'Lincoln', region: 'Lincolnshire', lat: 53.2307, lng: -0.5406 },
  { name: 'Norwich', region: 'Norfolk', lat: 52.6309, lng: 1.2974 },
  { name: 'Cambridge', region: 'Cambridgeshire', lat: 52.2053, lng: 0.1218 },
  { name: 'Peterborough', region: 'Cambridgeshire', lat: 52.5695, lng: -0.2405 },
  { name: 'Ipswich', region: 'Suffolk', lat: 52.0567, lng: 1.1482 },
  { name: 'Oxford', region: 'Oxfordshire', lat: 51.752, lng: -1.2577 },
  { name: 'Milton Keynes', region: 'Buckinghamshire', lat: 52.0406, lng: -0.7594 },
  { name: 'Northampton', region: 'Northamptonshire', lat: 52.2405, lng: -0.9027 },
  { name: 'Luton', region: 'Bedfordshire', lat: 51.8787, lng: -0.4200 },
  { name: 'Reading', region: 'Berkshire', lat: 51.4543, lng: -0.9781 },
  { name: 'Swindon', region: 'Wiltshire', lat: 51.5558, lng: -1.7797 },
  { name: 'Bristol', region: 'South West England', lat: 51.4545, lng: -2.5879 },
  { name: 'Bath', region: 'Somerset', lat: 51.3811, lng: -2.3590 },
  { name: 'Gloucester', region: 'Gloucestershire', lat: 51.8642, lng: -2.2382 },
  { name: 'Cheltenham', region: 'Gloucestershire', lat: 51.9, lng: -2.0715 },
  { name: 'Exeter', region: 'Devon', lat: 50.7184, lng: -3.5339 },
  { name: 'Plymouth', region: 'Devon', lat: 50.3755, lng: -4.1427 },
  { name: 'Truro', region: 'Cornwall', lat: 50.2632, lng: -5.0510 },
  { name: 'Southampton', region: 'Hampshire', lat: 50.9097, lng: -1.4044 },
  { name: 'Portsmouth', region: 'Hampshire', lat: 50.8198, lng: -1.0880 },
  { name: 'Brighton', region: 'East Sussex', lat: 50.8225, lng: -0.1372 },
  { name: 'Canterbury', region: 'Kent', lat: 51.2802, lng: 1.0789 },
  { name: 'Dover', region: 'Kent', lat: 51.1279, lng: 1.3134 },
  { name: 'London', region: 'Greater London', lat: 51.5074, lng: -0.1278 },
  { name: 'Cardiff', region: 'Wales', lat: 51.4816, lng: -3.1791 },
  { name: 'Swansea', region: 'Wales', lat: 51.6214, lng: -3.9436 },
  { name: 'Newport', region: 'Wales', lat: 51.5842, lng: -2.9977 },
  { name: 'Belfast', region: 'Northern Ireland', lat: 54.5973, lng: -5.9301 },
  { name: 'Derry', region: 'Northern Ireland', lat: 54.9966, lng: -7.3086 },
];

/** A crude UK-population-weighted centre, used only as a last-resort fallback (e.g. a fresh
 * user with no location set yet and no city search performed) — a genuinely central point, not
 * a London-shaped assumption dressed up as a default. */
export const UK_FALLBACK_CENTER: UkPlace = { name: 'Birmingham', region: 'West Midlands', lat: 52.4862, lng: -1.8904 };

export function searchUkPlaces(query: string, limit = 8): UkPlace[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = UK_PLACES.filter((p) => p.name.toLowerCase().startsWith(q));
  const contains = UK_PLACES.filter((p) => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/**
 * The single closest gazetteer town/city to an arbitrary point — used to anchor a radius search
 * centred somewhere that isn't itself one of our named places (a postcode, in particular:
 * provider inventory is synced per named city — see mock/ticketingProvider.ts's CITY_VENUES and
 * providers/live/openStreetMap.ts's UK_PLACES lookup — so a raw postcode centre needs at least
 * one real place to actually sync before there's anything to search). UK_PLACES is never empty,
 * so this always returns a real place.
 */
export function nearestUkPlace(lat: number, lng: number): UkPlace {
  return UK_PLACES.reduce((closest, place) => (haversineKm(lat, lng, place.lat, place.lng) < haversineKm(lat, lng, closest.lat, closest.lng) ? place : closest));
}

/**
 * Every gazetteer place within `radiusKm` of a point, nearest first, capped to `maxCount` —
 * Explore's "extend the map radius" search (services/explore.ts#listExploreExperiencesByRadius)
 * syncs and queries exactly this set of real cities/towns, never a fabricated wider catalogue.
 * The cap exists because a large radius in a densely-covered region (the Midlands, in
 * particular) can otherwise pull in a dozen-plus places, each needing its own provider sync —
 * bounding it keeps a radius search's worst-case latency sane. Always includes the nearest
 * place even if it technically falls just outside `radiusKm` (rounding, or a very tight radius
 * around a point that isn't itself a named place), so a radius search never comes back with
 * literally nothing to sync.
 */
export function placesWithinRadiusKm(lat: number, lng: number, radiusKm: number, maxCount = 10): UkPlace[] {
  const withDistance = UK_PLACES.map((place) => ({ place, distanceKm: haversineKm(lat, lng, place.lat, place.lng) })).sort((a, b) => a.distanceKm - b.distanceKm);
  const within = withDistance.filter((p) => p.distanceKm <= radiusKm);
  const result = within.length > 0 ? within : withDistance.slice(0, 1); // guarantee at least the nearest place
  return result.slice(0, maxCount).map((p) => p.place);
}
