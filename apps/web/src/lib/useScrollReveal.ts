'use client';
import { useEffect } from 'react';

/**
 * Progressive scroll-triggered reveal — the gap this closes: every animation built so far
 * (pop-in, tap-feedback, settle, arrive) fires in RESPONSE to an action — a vote, a reaction, a
 * send. None of them fire in response to scrolling itself, so a long page (Explore's grid, a
 * full Plans list) rendered every card fully visible from first paint — nothing moved as you
 * scrolled down to it. This is the distinct, separate primitive for that: content already in
 * the viewport at mount renders immediately (no flash-then-fade on first paint), but anything
 * below the fold fades and slides up into place as it scrolls into view.
 *
 * Deliberately NOT a wrapper component — it toggles a class on elements that already carry
 * `.v2-reveal` (+ optional `--reveal-i` stagger index, same convention as `.v2-stagger`), so it
 * never inserts an extra DOM node into an existing CSS Grid/Flex layout.
 *
 * A MutationObserver (not just a one-off querySelectorAll on mount) is what makes this safe to
 * call unconditionally at the top of a page component whose real content — Explore's result
 * grid, a Plans list — only exists once an async fetch resolves *after* this effect's first run.
 * Without it, cards rendered later would never get scanned and would sit at opacity:0 forever.
 * Call once per page component; Next.js app-router page components remount fresh on client-side
 * navigation, so a new observer pair is wired up correctly every time you land on the page.
 */
export function useScrollReveal() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const io = reduced
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                entry.target.classList.add('v2-revealed');
                io!.unobserve(entry.target);
              }
            }
          },
          { rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
        );

    function scan() {
      const vh = window.innerHeight;
      document.querySelectorAll<HTMLElement>('.v2-reveal:not(.v2-revealed)').forEach((el) => {
        if (reduced || el.getBoundingClientRect().top < vh * 0.92) {
          // Already in (or very near) the viewport — or reduced motion — show immediately
          // rather than making it wait for a scroll event that may never come for this element.
          el.classList.add('v2-revealed');
        } else {
          io!.observe(el);
        }
      });
    }

    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      io?.disconnect();
    };
  }, []);
}
