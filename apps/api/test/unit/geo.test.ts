import { describe, expect, test } from 'vitest';
import { haversineKm, haversineMiles } from '../../src/lib/geo';

describe('haversineKm / haversineMiles', () => {
  test('distance from a point to itself is zero', () => {
    expect(haversineKm(51.5072, -0.1276, 51.5072, -0.1276)).toBeCloseTo(0, 5);
    expect(haversineMiles(51.5072, -0.1276, 51.5072, -0.1276)).toBeCloseTo(0, 5);
  });

  test('London to Birmingham is a real, roughly-correct distance (~163km / ~101mi great-circle)', () => {
    const london = { lat: 51.5072, lng: -0.1276 };
    const birmingham = { lat: 52.4862, lng: -1.8904 };
    const km = haversineKm(london.lat, london.lng, birmingham.lat, birmingham.lng);
    const miles = haversineMiles(london.lat, london.lng, birmingham.lat, birmingham.lng);
    expect(km).toBeGreaterThan(150);
    expect(km).toBeLessThan(175);
    expect(miles).toBeGreaterThan(90);
    expect(miles).toBeLessThan(110);
  });

  test('km and miles agree on the same real-world distance (1 mile ≈ 1.609km)', () => {
    const a = { lat: 52.8062, lng: -2.1169 }; // Stafford
    const b = { lat: 53.0027, lng: -2.1794 }; // Stoke-on-Trent
    const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
    const miles = haversineMiles(a.lat, a.lng, b.lat, b.lng);
    expect(km / miles).toBeCloseTo(1.60934, 1);
  });

  test('is symmetric — distance(a, b) === distance(b, a)', () => {
    const a = { lat: 55.9533, lng: -3.1883 }; // Edinburgh
    const b = { lat: 50.8225, lng: -0.1372 }; // Brighton
    expect(haversineKm(a.lat, a.lng, b.lat, b.lng)).toBeCloseTo(haversineKm(b.lat, b.lng, a.lat, a.lng), 8);
  });
});
