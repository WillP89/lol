'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Real, reported feedback ("still no movement at all... more immersive", pointing at a site built
 * on parallax/depth that responds to you): the previous rounds only ever had things drift on
 * their own timer — genuinely alive, but never REACTIVE. This is the difference a "the whole
 * scene responds to you" entrance needs: tracks the pointer's offset from the viewport centre,
 * normalised to roughly -1..1 on each axis, and writes it straight onto the given element as CSS
 * custom properties (`--px`, `--py`) — never React state, so moving the mouse never re-renders
 * anything; every layer that wants to react just reads `var(--px)`/`var(--py)` in its own
 * `transform: translate3d(calc(var(--px) * <depth>px), ...)`, each with its own depth multiplier,
 * for real multi-layer parallax with one shared, cheap source of truth.
 *
 * Deliberately does nothing (no listener ever attached, vars stay at their CSS-authored 0
 * default) for `prefers-reduced-motion: reduce` and for a device with no real pointer (a touch-
 * only phone reports `(pointer: coarse)`, and `mousemove` never meaningfully fires there anyway)
 * — those get the plain, still-genuinely-alive idle-drift/particle layers with no reactive layer
 * on top, never a broken half-working effect.
 */
export function usePointerParallax(ref: RefObject<HTMLElement | null>): void {
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;

    function flush() {
      const pending = pendingRef.current;
      if (pending && el) {
        el.style.setProperty('--px', pending.x.toFixed(4));
        el.style.setProperty('--py', pending.y.toFixed(4));
      }
      rafRef.current = null;
    }

    function handleMove(e: MouseEvent) {
      const x = (e.clientX / window.innerWidth) * 2 - 1;
      const y = (e.clientY / window.innerHeight) * 2 - 1;
      pendingRef.current = { x, y };
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
    }

    window.addEventListener('mousemove', handleMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMove);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [ref]);
}
