'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A focused-choice sheet with a backdrop — used wherever the app needs a decision (which Crew to
 * send this to, a destructive confirmation, the "+" action menu) without leaving the current
 * screen. Dismissible by tapping the backdrop, not just an explicit Cancel button.
 *
 * Mobile: slides up from the bottom, full-width. Desktop (≥720px): a centred dialog instead —
 * a bottom sheet stretched to the full window width and merely centred by margin has no
 * relationship to whatever layout is behind it (a split list+map, a chat column beside a Crews
 * rail); on a wide viewport it just floats mid-screen across whatever happens to be there. A
 * proper centred dialog is the correct desktop pattern for the exact same "focused choice"
 * job, and it's self-contained regardless of what's behind it. See
 * docs/DECISIONS.md#plot-design-reset.
 *
 * Rendered into a `document.body` portal, not inline where it's called — a real, subtle CSS bug
 * found via live testing (the Plot-avatar/Crew-art gallery, opened from inside the Crew-creation
 * "Give it a look" sheet, had every tap on its own content swallowed by the OUTER sheet's
 * backdrop): this panel sets `transform` for its slide-up animation, and per the CSS spec any
 * transformed element becomes the containing block for its `position: fixed` DESCENDANTS — so a
 * BottomSheet nested inside another BottomSheet's panel was never actually "fixed to the
 * viewport" the way its own CSS claimed; it was silently confined to the outer panel's own
 * (much smaller) box, with the outer panel's full-viewport backdrop still on top for everywhere
 * outside that box. A z-index bump alone couldn't fix this — it's a containing-block problem,
 * not a stacking-order one. A portal is the standard, correct fix: it renders outside the
 * component tree entirely, so no ancestor's `transform` can ever intercept it, at any nesting
 * depth.
 */
export function BottomSheet({
  open,
  onClose,
  children,
  zIndex = 50,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  // A nested sheet (see the portal note above) still benefits from an explicit higher value —
  // the portal fixes *containment*, but two sibling portalled sheets open at once (outer +
  // inner) still stack by z-index, and the inner one should always read as "in front".
  zIndex?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Portals need a real DOM `document.body` to render into, which doesn't exist during SSR —
  // mount happens client-side only, one tick after first render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Prevents the page behind the sheet from scrolling while it's open — otherwise a drag on
  // the sheet can scroll the page underneath it, which reads as broken on mobile.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // A stable ref to the latest `onClose`, NOT a dependency of the effect below — real,
  // release-blocking bug this fixes: every caller passes an inline `onClose` arrow
  // (`() => setShowCreate(false)`, etc.), which gets a brand-new function identity on every
  // render of the PARENT. With `onClose` in the effect's dependency array, typing a single
  // character into any input inside an open sheet (Crew creation's name field, first and worst
  // hit) re-renders the parent, which re-runs this effect — and the OLD effect's cleanup calls
  // `previouslyFocused.current?.focus()`, yanking focus back to whatever was focused *before*
  // the sheet opened (the "New Crew" button, or the page body) and away from the input the
  // person was actively typing into. One character in, focus gone, every keystroke. Keeping the
  // callback in a ref instead means the effect only depends on `open` — it runs once when the
  // sheet opens and once when it closes, never on an unrelated parent re-render — while
  // `onKeyDown` still always calls whatever `onClose` is current via the ref.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Real accessibility gaps this closes (brief: "keyboard, focus, screen-reader labels, modal
  // focus" — every sheet in the app shares this one component, so the fix applies everywhere at
  // once): Escape had no effect, focus never moved into the sheet on open or back to whatever
  // opened it on close, and screen readers had no signal this was a modal dialog at all.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // A short delay lets the open transition's initial render settle before moving focus —
    // moving it synchronously on mount can fight the transform transition in some browsers.
    const focusTimer = setTimeout(() => panelRef.current?.focus(), 50);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        display: open ? 'flex' : 'none',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      // "v2" here is NOT decorative — real regression this fixes: `--v2-*` custom properties
      // (surface colour, ink, line, radii — everything every inline style below reads via
      // `var(--v2-…)`) are defined on the `.v2` class (globals.css), scoped to the per-page
      // wrapper div. A `createPortal` target is `document.body` — a SIBLING of that wrapper in
      // the real DOM, not a descendant — so none of those variables were reachable here at all,
      // and every var(...) silently resolved to nothing (a transparent panel background, for
      // one). Re-declaring the class at the portal root re-establishes the whole variable set
      // fresh, right where this subtree actually lives in the DOM.
      className="v2 v2-sheet-root"
    >
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(22, 19, 15, 0.5)',
          opacity: open ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}
      />
      <div
        ref={panelRef}
        className="v2-sheet-panel"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={{
          position: 'relative',
          width: '100%',
          background: 'var(--v2-surface)',
          border: '1px solid var(--v2-line)',
          // Real bug, confirmed via a live screenshot on a real (non-maximised, not full-height)
          // browser window: with no max-height, tall content (an event's image + description +
          // button) got cut off at the bottom of the viewport with no way to scroll to it. Fixed
          // height + its own scroll means the sheet always fits, however short the window is.
          maxHeight: 'calc(100dvh - 40px)',
          overflowY: 'auto',
          padding: '10px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)',
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.25s cubic-bezier(.32,.72,0,1)',
          boxShadow: 'var(--v2-shadow-lg)',
          outline: 'none',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="v2-tap-feedback"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '10px 0 8px', margin: '-6px 0 8px', position: 'sticky', top: 0, border: 'none', background: 'none', cursor: 'pointer' }}
        >
          <span style={{ width: 36, height: 4, borderRadius: 4, background: 'var(--v2-ink-dim)', opacity: 0.4 }} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
