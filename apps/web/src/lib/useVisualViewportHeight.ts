'use client';

import { useEffect, useState } from 'react';

/**
 * Real mobile-keyboard handling for the chat composer — not `position: fixed; bottom: 0` and
 * calling it done (a fixed composer sits at the bottom of the LAYOUT viewport, which the
 * on-screen keyboard does not resize on iOS Safari; it just overlays on top, so a naively fixed
 * composer ends up hidden behind the keyboard the moment it opens).
 *
 * CSS `100dvh` handles the OTHER mobile-chrome case correctly (the address bar collapsing on
 * scroll), but it does not reliably track the keyboard opening on iOS — the dynamic viewport
 * unit is about browser chrome, not the software keyboard. `window.visualViewport` is the one
 * API that DOES report the keyboard correctly on both iOS and Android: its `height` shrinks the
 * moment the keyboard appears and grows back the moment it's dismissed. This hook is the real
 * source of truth for "how much vertical space is actually usable right now"; callers should
 * fall back to a `dvh`-based CSS value when it returns null (SSR, or a browser old enough not to
 * have the API at all — desktop browsers all have it, but nothing here depends on it there since
 * there's no on-screen keyboard to react to).
 *
 * `offsetTop` is the other half of the same real bug ("the whole interface moves, it should be
 * LOCKED"): shrinking a STATIC-positioned element's height to match the visual viewport is not,
 * on its own, enough — iOS Safari's own "scroll the focused input into view above the keyboard"
 * behaviour still runs independently on the LAYOUT viewport (which never resizes), scrolling the
 * whole page by some amount the app does not control. A height fix with no positioning fix just
 * lets that native scroll and the app's own shrink compound: the container ends up the right
 * SIZE, sitting at the wrong PLACE — exactly the reported "composer floats with a dead gap below
 * it" symptom. `visualViewport.offsetTop` is the live measurement of exactly how far the native
 * scroll has shifted the visual viewport from the layout viewport's own top edge; a caller that
 * pins itself with `position: fixed` and offsets by this value stays glued to whatever is
 * ACTUALLY visible right now, regardless of what the browser's own scroll does underneath it.
 */
export function useVisualViewportHeight(): { height: number; offsetTop: number } | null {
  const [state, setState] = useState<{ height: number; offsetTop: number } | null>(null);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    function update() {
      setState({ height: vv!.height, offsetTop: vv!.offsetTop });
    }
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return state;
}
