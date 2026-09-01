import { describe, expect, test } from 'vitest';
import { nearestUkPlace, placesWithinRadiusKm, UK_PLACES } from '../../src/data/ukPlaces';
import { haversineKm } from '../../src/lib/geo';

describe('nearestUkPlace', () => {
  test('a point right on a gazetteer place resolves to that same place', () => {
    const stafford = UK_PLACES.find((p) => p.name === 'Stafford')!;
    expect(nearestUkPlace(stafford.lat, stafford.lng).name).toBe('Stafford');
  });

  test('agrees with a brute-force nearest-by-real-distance search over every gazetteer place, in a dense multi-town area', () => {
    // Staffordshire has several gazetteer places within a few km of each other — exactly the
    // case worth checking against a genuinely independent brute-force computation rather than a
    // hand-guessed "obviously closer to X" assumption, which is real geography, easy to get
    // wrong by eye.
    const point = { lat: 52.97, lng: -2.18 };
    const bruteForce = [...UK_PLACES].sort((a, b) => haversineKm(point.lat, point.lng, a.lat, a.lng) - haversineKm(point.lat, point.lng, b.lat, b.lng))[0];
    expect(nearestUkPlace(point.lat, point.lng).name).toBe(bruteForce.name);
  });

  test('agrees with a brute-force nearest-by-real-distance search over every gazetteer place', () => {
    const point = { lat: 51.75, lng: -1.5 }; // roughly Oxfordshire — no special-cased assumption
    const bruteForce = [...UK_PLACES].sort((a, b) => haversineKm(point.lat, point.lng, a.lat, a.lng) - haversineKm(point.lat, point.lng, b.lat, b.lng))[0];
    expect(nearestUkPlace(point.lat, point.lng).name).toBe(bruteForce.name);
  });
});

describe('placesWithinRadiusKm', () => {
  test('a tiny radius around Stafford still returns at least Stafford itself', () => {
    const stafford = UK_PLACES.find((p) => p.name === 'Stafford')!;
    const places = placesWithinRadiusKm(stafford.lat, stafford.lng, 0.001);
    expect(places.length).toBeGreaterThan(0);
    expect(places[0].name).toBe('Stafford');
  });

  test('widening the radius genuinely returns more real places, nearest first', () => {
    const stafford = UK_PLACES.find((p) => p.name === 'Stafford')!;
    const tight = placesWithinRadiusKm(stafford.lat, stafford.lng, 5);
    const wide = placesWithinRadiusKm(stafford.lat, stafford.lng, 40);
    expect(wide.length).toBeGreaterThan(tight.length);
    // Every place in the tight radius is still present in the wider one.
    for (const p of tight) expect(wide.some((w) => w.name === p.name)).toBe(true);
    // Nearest-first ordering — real great-circle distance, not a raw lat/lng Euclidean proxy
    // (which isn't actually proportional to real distance: longitude degrees compress at higher
    // latitudes, so it can misorder two real candidates that haversineKm correctly orders).
    for (let i = 1; i < wide.length; i++) {
      const prevKm = haversineKm(stafford.lat, stafford.lng, wide[i - 1].lat, wide[i - 1].lng);
      const curKm = haversineKm(stafford.lat, stafford.lng, wide[i].lat, wide[i].lng);
      expect(curKm).toBeGreaterThanOrEqual(prevKm - 1e-9);
    }
  });

  test('the result is capped at maxCount even when many real places are in range', () => {
    const stafford = UK_PLACES.find((p) => p.name === 'Stafford')!;
    const places = placesWithinRadiusKm(stafford.lat, stafford.lng, 500, 3);
    expect(places.length).toBeLessThanOrEqual(3);
  });

  test('a radius around a point far from any gazetteer place still returns the single nearest one', () => {
    // The middle of the North Sea — no real UK town is remotely close, but the function must
    // never come back empty (Explore's radius search always needs at least one city to sync).
    const places = placesWithinRadiusKm(56.5, 2.5, 5);
    expect(places.length).toBe(1);
  });
});
