import { describe, it, expect } from 'vitest';
import { ticketmasterProvider } from '../src/providers/live/ticketmaster';
import type { RawListing } from '../src/providers/types';

/**
 * "Only use HIGH QUALITY HD images across the board, some of the images look stretched and
 * distorted" — the real fix (see ticketmaster.ts#bestImage and its MIN_IMAGE_WIDTH comment) is a
 * resolution floor at ingestion: an image narrower than what a hero card actually renders it at
 * gets visibly blown up past its native resolution by CSS `background-size: cover`, which is
 * what "stretched and distorted" was actually describing (cover crops, it never skews aspect
 * ratio — the complaint was really about upscaled low-res bitmaps, not a CSS bug). Below that
 * floor, no image is better than a blurry one — v2Art's editorial fallback art is the intended
 * result, not a pixelated photo.
 */
function tmEvent(overrides: Partial<{ images: { url: string; width: number; height: number; ratio?: string }[] }>) {
  return {
    id: 'tm-1',
    name: 'Test Event',
    url: 'https://ticketmaster.example/event/1',
    images: overrides.images,
    dates: { start: { dateTime: '2026-06-01T20:00:00Z' } },
    classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }],
    _embedded: { venues: [{ name: 'Test Venue', location: { latitude: '52.4839', longitude: '-1.8947' } }] },
  };
}

function mapListing(images?: { url: string; width: number; height: number; ratio?: string }[]) {
  const listing: RawListing = { externalId: 'tm-1', raw: tmEvent({ images }) };
  return ticketmasterProvider.mapToCanonical(listing);
}

describe('image quality — resolution floor at ingestion', () => {
  it('rejects every candidate below the floor rather than falling back to a low-res one', () => {
    const result = mapListing([
      { url: 'https://img.example/tiny-square.jpg', width: 100, height: 100, ratio: '1_1' },
      { url: 'https://img.example/small-wide.jpg', width: 305, height: 172, ratio: '16_9' },
    ]);
    expect(result.imageUrl).toBeNull();
    expect(result.imageSource).toBeNull();
  });

  it('picks the highest-resolution 16:9 candidate over a smaller one, never just the first in the array', () => {
    const result = mapListing([
      { url: 'https://img.example/wide-1800.jpg', width: 1800, height: 1013, ratio: '16_9' },
      { url: 'https://img.example/wide-2400.jpg', width: 2400, height: 1350, ratio: '16_9' },
    ]);
    expect(result.imageUrl).toBe('https://img.example/wide-2400.jpg');
    expect(result.imageSource).toBe('TICKETMASTER');
  });

  it('falls back to the best non-16:9 candidate that clears the floor when no wide image does', () => {
    const result = mapListing([
      { url: 'https://img.example/square-1800.jpg', width: 1800, height: 1800, ratio: '1_1' },
      { url: 'https://img.example/tiny-wide.jpg', width: 200, height: 112, ratio: '16_9' },
    ]);
    expect(result.imageUrl).toBe('https://img.example/square-1800.jpg');
  });

  it('returns no image at all when the event has none, rather than throwing', () => {
    const result = mapListing(undefined);
    expect(result.imageUrl).toBeNull();
  });
});
