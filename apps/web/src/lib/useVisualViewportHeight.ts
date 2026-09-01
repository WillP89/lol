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
