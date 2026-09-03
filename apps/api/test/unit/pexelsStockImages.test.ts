import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The live Pexels search API isn't reachable from this environment (see pexelsStockImages.ts's
 * own top comment) — these tests exercise the module's actual logic (result parsing, dimension/
 * aspect-ratio filtering, per-item hash variation, caching, graceful failure, the missing-API-key
 * no-op) against a mocked `fetch` built from the search API's real, documented response shape, not
 * a live call. `vi.resetModules()` between tests (rather than the module-level cache reset export
 * every other enrichment module here has) because this module ALSO reads `config.PEXELS_API_KEY`
 * at call time via a fresh `vi.doMock` per test — the key has to vary between tests (missing vs.
 * present), which a single shared config import can't do.
 */
function pexelsPhoto(width: number, height: number, alt: string) {
  return { width, height, alt, src: { large2x: `https://images.pexels.com/photos/${alt.replace(/\s+/g, '-')}.jpg` } };
}

async function loadWithKey(apiKey: string | undefined) {
  vi.resetModules();
  vi.doMock('../../src/lib/config', () => ({ config: { PEXELS_API_KEY: apiKey } }));
  return import('../../src/lib/pexelsStockImages');
}

describe('getPexelsStockImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock('../../src/lib/config');
  });

  test('no PEXELS_API_KEY configured is a clean no-op — never a crash, never calls fetch', async () => {
    const { getPexelsStockImage } = await loadWithKey(undefined);
    const result = await getPexelsStockImage('LIVE_MUSIC', 'Anything');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns a real photo url from a search result that clears the resolution/aspect-ratio floor', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [pexelsPhoto(1920, 1280, 'Gig crowd')] }) });
    const { getPexelsStockImage } = await loadWithKey('test-key');
    const result = await getPexelsStockImage('LIVE_MUSIC', 'Some Unknown Local Night');
    expect(result).toEqual({ url: 'https://images.pexels.com/photos/Gig-crowd.jpg', sourcePage: 'Gig crowd' });
  });

  test('sends the configured key as the Authorization header', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [pexelsPhoto(1920, 1280, 'Gig crowd')] }) });
    const { getPexelsStockImage } = await loadWithKey('my-real-key');
    await getPexelsStockImage('LIVE_MUSIC', 'Anything');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe('my-real-key');
  });

  test('a result too small to clear the resolution floor is filtered out of the pool', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [pexelsPhoto(400, 300, 'Tiny')] }) });
    const { getPexelsStockImage } = await loadWithKey('test-key');
    const result = await getPexelsStockImage('LIVE_MUSIC', 'Anything');
    expect(result).toBeNull();
  });

  test('a result with an extreme aspect ratio is filtered out of the pool', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [pexelsPhoto(4000, 200, 'Banner')] }) });
    const { getPexelsStockImage } = await loadWithKey('test-key');
    const result = await getPexelsStockImage('LIVE_MUSIC', 'Anything');
    expect(result).toBeNull();
  });

  test('an unrecognised category falls back to the CUSTOM search query rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [pexelsPhoto(1920, 1280, 'Party')] }) });
    const { getPexelsStockImage } = await loadWithKey('test-key');
    const result = await getPexelsStockImage('SOMETHING_NEW', 'Anything');
    expect(result).not.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toContain('celebration+party');
  });

  test('a network failure is swallowed — enrichment is best-effort and must never throw into the sync loop', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network unreachable'));
    const { getPexelsStockImage } = await loadWithKey('test-key');
    await expect(getPexelsStockImage('LIVE_MUSIC', 'Anything')).resolves.toBeNull();
  });

  test('a non-ok response (e.g. a bad/expired key) is swallowed, not thrown', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const { getPexelsStockImage } = await loadWithKey('bad-key');
    await expect(getPexelsStockImage('LIVE_MUSIC', 'Anything')).resolves.toBeNull();
  });

  test('the same category is only searched once per process, even across many listings', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ photos: [pexelsPhoto(1920, 1280, 'Once')] }) });
    const { getPexelsStockImage } = await loadWithKey('test-key');
    await getPexelsStockImage('RESTAURANT', 'Diner One');
    await getPexelsStockImage('RESTAURANT', 'Diner Two');
    await getPexelsStockImage('RESTAURANT', 'Diner Three');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('different listings in the same category spread across the pool instead of all landing on one photo', async () => {
    const photos = Array.from({ length: 10 }, (_, i) => pexelsPhoto(1920, 1280, `Photo ${i}`));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos }) });
    const { getPexelsStockImage } = await loadWithKey('test-key');
    const seeds = ['The Comedy Cellar Special', 'Open Mic Night at The Bell', 'Laugh Track Live', 'Chuckle Hut Tuesdays', 'Giggle Barn Weekly'];
    const urls = [];
    for (const seed of seeds) urls.push(await getPexelsStockImage('COMEDY', seed));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls.every((u) => u !== null)).toBe(true);
    expect(new Set(urls.map((u) => u?.url)).size).toBeGreaterThan(1);
  });

  /**
   * Real, production-confirmed bug — see categoryStockImages.test.ts's own matching test for the
   * full story (a live backfill run filled only 144/432 rows, a category-shaped miss pattern from
   * a transient failure poisoning a category's cache for the full 30-minute positive-cache TTL).
   */
  test('a failed/empty search retries quickly, not stuck for the full 30-minute positive-cache window', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    nowSpy.mockImplementation(() => clock);

    fetchMock.mockRejectedValueOnce(new Error('transient network blip'));
    const { getPexelsStockImage } = await loadWithKey('test-key');
    const first = await getPexelsStockImage('THEATRE', 'Some Show');
    expect(first).toBeNull();

    clock += 5_000; // well inside the new short negative-cache window — must NOT re-fetch yet
    const stillCached = await getPexelsStockImage('THEATRE', 'Another Show');
    expect(stillCached).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 30_000; // past it — the real fix: a retry now, not stuck for the full 30 minutes
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ photos: [pexelsPhoto(1920, 1280, 'Recovered')] }) });
    const recovered = await getPexelsStockImage('THEATRE', 'A Third Show');
    expect(recovered).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });
});
