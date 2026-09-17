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

  /**
   * P0 FOUNDATION FAILURE (real, live-reported): an "RM" headline show — a real drill/hip-hop
   * event — displayed rock-band imagery. `type: 'standard'` alone only proves Wikipedia found
   * SOME real page for the query string, never that it's the RIGHT one — a short/ambiguous name
   * can confidently resolve to a completely unrelated real subject. These prove the new category-
   * plausibility cross-check (using `description`/`extract`, already present in the same response
   * — no extra request) catches exactly that failure, without over-blocking categories that have
   * no domain check defined at all.
   */
  describe('category-plausibility cross-check (P0-2)', () => {
    test('a LIVE_MUSIC lookup whose resolved page describes an unrelated domain (a rock band, not a musician generally) is rejected', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          type: 'standard',
          title: 'R.E.M.',
          description: 'American rock band',
          extract: 'R.E.M. was an American rock band formed in Athens, Georgia in 1980.',
          thumbnail: { source: 'https://upload.wikimedia.org/rem.jpg' },
        }),
      });
      const result = await enrichImageFromWikipedia('RM', 'LIVE_MUSIC');
      expect(result).toBeNull();
    });

    test('a LIVE_MUSIC lookup whose resolved page genuinely describes a musician is accepted', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          type: 'standard',
          title: 'RM (rapper)',
          description: 'South Korean rapper',
          extract: 'RM is a South Korean rapper and record producer.',
          originalimage: { source: 'https://upload.wikimedia.org/rm-rapper.jpg' },
        }),
      });
      const result = await enrichImageFromWikipedia('RM the rapper', 'LIVE_MUSIC');
      expect(result).toEqual({ url: 'https://upload.wikimedia.org/rm-rapper.jpg', sourcePage: 'RM (rapper)' });
    });

    test('a resolved page with no description or extract at all is unverifiable and rejected, never trusted on type alone', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ type: 'standard', title: 'Some Standard Page', thumbnail: { source: 'https://upload.wikimedia.org/blank.jpg' } }),
      });
      const result = await enrichImageFromWikipedia('Ambiguous Name', 'LIVE_MUSIC');
      expect(result).toBeNull();
    });

    test('a category with no domain check defined (e.g. RESTAURANT) keeps the original, unchanged behaviour', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ type: 'standard', title: 'Some Restaurant', originalimage: { source: 'https://upload.wikimedia.org/restaurant.jpg' } }),
      });
      const result = await enrichImageFromWikipedia('Some Restaurant Unique Name', 'RESTAURANT');
      expect(result).toEqual({ url: 'https://upload.wikimedia.org/restaurant.jpg', sourcePage: 'Some Restaurant' });
    });

    test('a COMEDY lookup that genuinely describes a comedian is accepted', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          type: 'standard',
          title: 'A Real Comedian',
          description: 'English stand-up comedian',
          originalimage: { source: 'https://upload.wikimedia.org/comedian.jpg' },
        }),
      });
      const result = await enrichImageFromWikipedia('A Real Comedian Unique', 'COMEDY');
      expect(result).toEqual({ url: 'https://upload.wikimedia.org/comedian.jpg', sourcePage: 'A Real Comedian' });
    });

    test('a SPORT lookup whose resolved page is not a sport-domain subject is rejected', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          type: 'standard',
          title: 'Unrelated Musician',
          description: 'American singer-songwriter',
          thumbnail: { source: 'https://upload.wikimedia.org/singer.jpg' },
        }),
      });
      const result = await enrichImageFromWikipedia('Ambiguous Team Name Unique', 'SPORT');
      expect(result).toBeNull();
    });

    test('the same name under two different categories is cached separately, never sharing a false hit', async () => {
      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ type: 'standard', title: 'RM Dual', description: 'South Korean rapper', originalimage: { source: 'https://upload.wikimedia.org/rm-music.jpg' } }),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ type: 'standard', title: 'RM Dual', description: 'South Korean rapper', originalimage: { source: 'https://upload.wikimedia.org/rm-music.jpg' } }),
        });
      const musicResult = await enrichImageFromWikipedia('RM Dual Category Test', 'LIVE_MUSIC');
      const sportResult = await enrichImageFromWikipedia('RM Dual Category Test', 'SPORT');
      expect(musicResult).not.toBeNull(); // "South Korean rapper" is plausible for LIVE_MUSIC
      expect(sportResult).toBeNull(); // the exact same page is NOT plausible for SPORT
      expect(fetchMock).toHaveBeenCalledTimes(2); // a real second lookup, not a stale cross-category cache hit
    });
  });
});
