import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { logger } from '../../src/lib/logger';
import { openStreetMapProvider } from '../../src/providers/live/openStreetMap';
import { fhrsProvider } from '../../src/providers/live/fhrs';

/**
 * Real operator-visibility gap flagged (not fixed) in Cycle 4's own systematic gate audit, closed
 * here: both OpenStreetMap's `MAX_RESULTS` and FHRS's `MAX_PAGES` silently truncate real inventory
 * for a dense enough city, with nothing in the response distinguishing "this city genuinely only
 * has N venues" from "there were more, and the rest were cut off" — an operator investigating thin
 * coverage for a real city had no signal to go on. See each adapter's own inline comment for the
 * exact reasoning; this proves the warning actually fires when the cap is genuinely hit, and does
 * NOT fire for a city with fewer real results than the cap (the common, non-truncated case).
 */

let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openStreetMapProvider.fetchListings truncation logging', () => {
  test('logs a warning when the result count reaches MAX_RESULTS (120) — real inventory may be cut off', async () => {
    const elements = Array.from({ length: 120 }, (_, i) => ({
      type: 'node',
      id: i,
      lat: 52.4862,
      lon: -1.8904,
      tags: { name: `Venue ${i}`, amenity: 'restaurant' },
    }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements }) });

    await openStreetMapProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ city: 'Birmingham', maxResults: 120 }), expect.stringContaining('MAX_RESULTS'));
  });

  test('does NOT log the truncation warning when a city genuinely has fewer results than the cap', async () => {
    const elements = [{ type: 'node', id: 1, lat: 52.4862, lon: -1.8904, tags: { name: 'The Only Venue', amenity: 'restaurant' } }];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements }) });

    await openStreetMapProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('MAX_RESULTS'));
  });
});

describe('fhrsProvider.fetchListings truncation logging', () => {
  function fhrsPage(count: number, totalPages: number) {
    const establishments = Array.from({ length: count }, (_, i) => ({
      FHRSID: i,
      BusinessName: `Restaurant ${i}`,
      BusinessType: 'Restaurant/Cafe/Canteen',
      geocode: { latitude: '52.4862', longitude: '-1.8904' },
    }));
    return { ok: true, json: async () => ({ establishments, meta: { totalCount: count * totalPages, totalPages } }) };
  }

  test('logs a warning when MAX_PAGES (2) is hit while the API reports more real pages exist', async () => {
    // 3 real total pages exist; MAX_PAGES caps this adapter at 2 — page 3 is genuinely lost.
    fetchMock.mockImplementation(async () => fhrsPage(100, 3));

    await fhrsProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ city: 'Birmingham', maxPages: 2, totalPages: 3 }), expect.stringContaining('MAX_PAGES'));
  });

  test('does NOT log the truncation warning when every real page fits within MAX_PAGES', async () => {
    fetchMock.mockImplementation(async () => fhrsPage(50, 1));

    await fhrsProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('MAX_PAGES'));
  });
});
