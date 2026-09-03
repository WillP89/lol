'use client';

import { useEffect, useState } from 'react';

/**
 * Real mobile-keyboard handling for the chat composer — not `position: fixed; bottom: 0` and
 * calling it done (a fixed composer sits at the bottom of the LAYOUT viewport, which the
 * on-screen keyboard does not resize on iOS Safari; it just overlays on top, so a naively fixed
 * composer ends up hidden behind the keyboard the moment it opens).
 *
 * The REAL, primary fix for this now lives in layout.tsx's viewport meta — `interactive-widget:
 * resizes-content` (Safari 17.4+/iOS 17.4+, Chrome 108+) tells the browser itself to genuinely
 * resize the layout viewport, and therefore plain `100dvh`, for the keyboard, the same way it
 * already does for the address bar collapsing. This hook is what's left for the browsers that
 * don't understand that yet: `window.visualViewport.height` is the one older API that DOES
 * report the keyboard correctly on both iOS and Android, shrinking the moment it appears. Used
 * here for two things — a plain fallback height value (see crews/[id]/page.tsx's own
 * `chatViewportHeight`), and to re-run "scroll to the latest message" when the keyboard opens.
 *
 * Deliberately does NOT also report `visualViewport.offsetTop` any more, and callers should not
 * try to reconstruct a `position: fixed` + counter-transform from it — an earlier version of this
 * fix did exactly that, and live testing found it could itself introduce a spurious shift in at
 * least one real in-app browser (Gmail's own), on top of whatever the platform-level fix above
 * already handles correctly. Reconstructing "where the visible viewport really is" after the fact
 * is exactly the kind of per-WebView guesswork `interactive-widget` exists to make unnecessary;
 * this hook stays a plain height, not a positioning system.
 */
export function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    function update() {
      setHeight(vv!.height);
    }
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return height;
}
