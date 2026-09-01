import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { looksLikeUkPostcode, resolvePostcode } from '../../src/lib/postcodes';

/**
 * The live postcodes.io API isn't reachable from this environment (see postcodes.ts's own top
 * comment) — these tests exercise the module's actual logic (postcode-shape detection, full vs.
 * outcode resolution, 404 handling, graceful failure, caching) against a mocked `fetch` built
 * from the real, documented response shape of postcodes.io's /postcodes and /outcodes
 * endpoints, not a live call.
 */
describe('looksLikeUkPostcode', () => {
  test('recognises full postcodes, with or without the internal space', () => {
    expect(looksLikeUkPostcode('ST16 2LZ')).toBe(true);
    expect(looksLikeUkPostcode('ST162LZ')).toBe(true);
    expect(looksLikeUkPostcode('SW1A 1AA')).toBe(true);
    expect(looksLikeUkPostcode('sw1a 1aa')).toBe(true);
  });

  test('recognises a bare outward code (partial postcode)', () => {
    expect(looksLikeUkPostcode('ST16')).toBe(true);
    expect(looksLikeUkPostcode('M1')).toBe(true);
    expect(looksLikeUkPostcode('SW1A')).toBe(true);
  });

  test('an ordinary town name is not treated as a postcode', () => {
    expect(looksLikeUkPostcode('Manchester')).toBe(false);
    expect(looksLikeUkPostcode('Stoke-on-Trent')).toBe(false);
    expect(looksLikeUkPostcode('')).toBe(false);
  });
});

describe('resolvePostcode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('a real full postcode resolves to real coordinates', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ result: { postcode: 'ST16 2LZ', latitude: 52.8062, longitude: -2.1169, admin_district: 'Stafford' } }),
    });
    const result = await resolvePostcode('ST16 2LZ');
    expect(result).toEqual({ label: 'ST16 2LZ', kind: 'postcode', district: 'Stafford', lat: 52.8062, lng: -2.1169 });
    expect(fetchMock.mock.calls[0][0]).toContain('/postcodes/');
  });

  test('a full postcode that 404s falls back to its outward code (district centroid)', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ result: { outcode: 'ST16', latitude: 52.81, longitude: -2.12, admin_district: 'Stafford' } }),
      });
    const result = await resolvePostcode('ST16 9ZZ');
    expect(result).toEqual({ label: 'ST16', kind: 'outcode', district: 'Stafford', lat: 52.81, lng: -2.12 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a bare outward code resolves directly via /outcodes', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ result: { outcode: 'M1', latitude: 53.4808, longitude: -2.2426, admin_district: 'Manchester' } }),
    });
    const result = await resolvePostcode('M1');
    expect(result).toEqual({ label: 'M1', kind: 'outcode', district: 'Manchester', lat: 53.4808, lng: -2.2426 });
    expect(fetchMock.mock.calls[0][0]).toContain('/outcodes/');
  });

  test('not a postcode-shaped query at all returns null without ever calling fetch', async () => {
    const result = await resolvePostcode('Manchester');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a network failure is swallowed — resolution is best-effort and must never throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network unreachable'));
    // A postcode not used by any other test in this file — the cache is a real, deliberate
    // module-level singleton (same pattern as imageEnrichment.ts), so reusing an already-cached
    // postcode here would return the earlier successful result instead of exercising failure.
    await expect(resolvePostcode('EC1A 1BB')).resolves.toBeNull();
  });

  test('the same postcode is only fetched once — repeated calls hit the in-process cache', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ result: { postcode: 'SW1A 1AA', latitude: 51.5, longitude: -0.14, admin_district: 'Westminster' } }),
    });
    await resolvePostcode('SW1A 1AA');
    await resolvePostcode('sw1a 1aa'); // case-insensitive — same cache key
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
