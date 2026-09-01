import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { enrichImageFromWikipedia } from '../../src/lib/imageEnrichment';

/**
 * The live Wikipedia REST API isn't reachable from this environment (see imageEnrichment.ts's
 * own top comment) — these tests exercise the module's actual logic (parsing, disambiguation
 * handling, graceful failure, caching) against a mocked `fetch` built from the REST summary
 * endpoint's real, documented response shape, not a live call.
 */
describe('enrichImageFromWikipedia', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('a standard page with a thumbnail returns the real image url and source page', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({
        type: 'standard',
        title: 'Fred again..',
        thumbnail: { source: 'https://upload.wikimedia.org/thumb-fred.jpg' },
        originalimage: { source: 'https://upload.wikimedia.org/original-fred.jpg' },
      }),
    });

    const result = await enrichImageFromWikipedia('Fred again..');
    expect(result).toEqual({ url: 'https://upload.wikimedia.org/original-fred.jpg', sourcePage: 'Fred again..' });
  });

  test('a 404 (no matching article) returns null, not an error — an expected, common outcome', async () => {
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
    const result = await enrichImageFromWikipedia('Some Obscure Local Comedy Night');
    expect(result).toBeNull();
  });

  test('a disambiguation page is treated as no confident match, never showing the wrong subject\'s photo', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ type: 'disambiguation', title: 'Nia', thumbnail: { source: 'https://upload.wikimedia.org/nia.jpg' } }),
    });
    const result = await enrichImageFromWikipedia('Nia');
    expect(result).toBeNull();
  });

  test('a network failure is swallowed — enrichment is best-effort and must never throw into the sync loop', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network unreachable'));
    await expect(enrichImageFromWikipedia('Anything')).resolves.toBeNull();
  });

  test('the same name is only fetched once — repeated calls hit the in-process cache', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ type: 'standard', title: 'Cached Artist', thumbnail: { source: 'https://upload.wikimedia.org/cached.jpg' } }),
    });
    await enrichImageFromWikipedia('Cached Artist Unique Name');
    await enrichImageFromWikipedia('Cached Artist Unique Name');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
