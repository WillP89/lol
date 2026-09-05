'use client';

import { ParticleField } from './ParticleField';

/**
 * THE SHARED BACKDROP for Plot's two marketing surfaces — the landing page's hero and the sign-in
 * page. Real, reported feedback after three previous rounds of tuning the old light-background
 * blob system ("doesn't pop enough... I want it to feel ALIVE, compare against the best in the
 * space"): more particles and bigger blobs on a pale canvas was never going to get there — a
 * saturated colour only reads as electric against something dark behind it. This is a genuine
 * rebuild, not another tuning pass, built from four layers that each move on their own clock so
 * the whole thing is unmistakably alive even before a cursor ever touches it:
 *
 *   1. `.v2-mkt-aurora` — a large conic gradient slowly rotating behind everything (the "always
 *      moving at rest" backbone the old version never had at all).
 *   2. `ParticleField` — the existing constellation particle system (unchanged), which reads with
 *      far more contrast on a dark canvas than it ever could on the old pale one.
 *   3. `.v2-mkt-spotlight` — a soft radial highlight that tracks the pointer via the same
 *      `--px`/`--py` custom properties `usePointerParallax` already writes on the page's root ref
 *      — the one layer that makes the darkness itself feel like it's reacting to you, not just
 *      the foreground content drifting.
 *   4. `.v2-mkt-grain` — a tiled noise texture over the top for a cinematic, printed-poster
 *      surface rather than a flat gradient (the same trick behind most dark marketing pages that
 *      read as "premium" rather than "a dark mode toggle").
 *
 * Both call sites still set their own root ref for `usePointerParallax` and still layer their own
 * additional page-specific elements (the landing hero's card marquee, the auth page's blurred
 * drift-cards) on top of this shared base — this component is deliberately just the base, not the
 * whole scene, so each page keeps its own personality on top of one consistent world. `aria-hidden`
 * throughout; every animation here respects `prefers-reduced-motion` (see globals.css).
 */
export function MarketingAtmosphere({ dense = true }: { dense?: boolean }) {
  return (
    <div aria-hidden className="v2-mkt-atmosphere">
      <div className="v2-mkt-aurora" />
      <ParticleField count={dense ? 130 : 70} />
      <div className="v2-mkt-spotlight" />
      <div className="v2-mkt-grain" />
    </div>
  );
}
