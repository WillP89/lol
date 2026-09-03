import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getCategoryStockImage, __resetCategoryStockImageCacheForTests } from '../../src/lib/categoryStockImages';

/**
 * The live Wikimedia Commons search API isn't reachable from this environment (see
 * categoryStockImages.ts's own top comment) — these tests exercise the module's actual logic
 * (result parsing, dimension/aspect-ratio filtering, per-item hash variation, caching, graceful
 * failure) against a mocked `fetch` built from the search API's real, documented response shape,
 * not a live call.
 */
function commonsPage(id: number, title: string, width: number, height: number) {
  return {
    [id]: {
      pageid: id,
      title,
      imageinfo: [{ url: `https://upload.wikimedia.org/original-${id}.jpg`, width: width * 2, height: height * 2, thumburl: `https://upload.wikimedia.org/thumb-${id}.jpg`, thumbwidth: width, thumbheight: height }],
    },
  };
}

describe('getCategoryStockImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    __resetCategoryStockImageCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('returns a real photo url from a search result that clears the resolution/aspect-ratio floor', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ query: { pages: commonsPage(1, 'File:Gig crowd.jpg', 1920, 1280) } }),
    });
    const result = await getCategoryStockImage('LIVE_MUSIC', 'Some Unknown Local Night');
    expect(result).toEqual({ url: 'https://upload.wikimedia.org/thumb-1.jpg', sourcePage: 'File:Gig crowd.jpg' });
  });

  test('a result too small to clear the resolution floor is filtered out of the pool', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ query: { pages: commonsPage(2, 'File:Tiny.jpg', 400, 300) } }),
    });
    const result = await getCategoryStockImage('LIVE_MUSIC', 'Anything');
    expect(result).toBeNull();
  });

  test('a result with an extreme aspect ratio is filtered out of the pool', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ query: { pages: commonsPage(3, 'File:Banner.jpg', 4000, 200) } }),
    });
    const result = await getCategoryStockImage('LIVE_MUSIC', 'Anything');
    expect(result).toBeNull();
  });

  test('an unrecognised category falls back to the CUSTOM search query rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ query: { pages: commonsPage(4, 'File:Party.jpg', 1920, 1280) } }),
    });
    const result = await getCategoryStockImage('SOMETHING_NEW', 'Anything');
    expect(result).not.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toContain('celebration+party+people');
  });

  test('a network failure is swallowed — enrichment is best-effort and must never throw into the sync loop', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network unreachable'));
    await expect(getCategoryStockImage('LIVE_MUSIC', 'Anything')).resolves.toBeNull();
  });

  test('different listings in the same category spread across the pool instead of all landing on one photo', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => commonsPage(100 + i, `File:Photo${i}.jpg`, 1920, 1280));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ query: { pages: Object.assign({}, ...entries) } }),
    });
    const seeds = ['The Comedy Cellar Special', 'Open Mic Night at The Bell', 'Laugh Track Live', 'Chuckle Hut Tuesdays', 'Giggle Barn Weekly'];
    // Sequential, matching inventorySync.ts's own real access pattern (one listing at a time in a
    // for-loop) — the pool is only ever populated once before the first concurrent caller for a
    // category could exist in production.
    const urls = [];
    for (const seed of seeds) urls.push(await getCategoryStockImage('COMEDY', seed));
    // Same live search only fetched once for the whole category (pool caching) — the different
    // listings still get to pick different photos out of that one shared pool rather than all
    // converging on the same result.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls.every((u) => u !== null)).toBe(true);
    expect(new Set(urls.map((u) => u?.url)).size).toBeGreaterThan(1);
  });

  test('the same listing (same seed) always lands on the same photo — no flicker across resyncs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ query: { pages: { ...commonsPage(8, 'File:X.jpg', 1920, 1280), ...commonsPage(9, 'File:Y.jpg', 1920, 1280) } } }),
    });
    const first = await getCategoryStockImage('BAR', 'The Anchor Quiz Night');
    __resetCategoryStockImageCacheForTests(); // force a fresh pool fetch, as a later sync run would
    const second = await getCategoryStockImage('BAR', 'The Anchor Quiz Night');
    expect(first?.url).toBe(second?.url);
  });

  test('the same category is only searched once per process, even across many listings', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ query: { pages: commonsPage(10, 'File:Once.jpg', 1920, 1280) } }),
    });
    await getCategoryStockImage('RESTAURANT', 'Diner One');
    await getCategoryStockImage('RESTAURANT', 'Diner Two');
    await getCategoryStockImage('RESTAURANT', 'Diner Three');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
