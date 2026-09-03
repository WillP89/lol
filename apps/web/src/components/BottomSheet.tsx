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

  // Real, live-reported complaint this fixes: "I should be able to swipe it down, not just tap
  // ... I hate the feel of it right now" — the sheet had no drag gesture at all, only a tap
  // target (the handle bar) styled to LOOK like a drag handle without behaving like one. This
  // makes the handle a genuine one — the whole panel follows the finger in real time while
  // dragging down, snaps closed past a real distance threshold, or springs back if released
  // short of it — the actual native bottom-sheet feel, not a static button pretending to be one.
  // Scoped to the handle strip specifically (not the whole panel/content below it) so it can
  // never fight a tap on a button or a scroll inside the sheet's own content.
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartYRef = useRef<number | null>(null);
  const DISMISS_DISTANCE = 90; // px dragged down before release counts as "let go to close"
  const TAP_DISTANCE = 6; // barely-moved drags are treated as a plain tap on the handle, not a swipe

  function handleDragStart(e: React.PointerEvent<HTMLDivElement>) {
    dragStartYRef.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleDragMove(e: React.PointerEvent<HTMLDivElement>) {
    if (dragStartYRef.current === null) return;
    // Only ever follows the finger DOWNWARD — dragging up has nothing to reveal above a sheet
    // that's already fully open, so clamping at 0 avoids an odd "rubber-band past the top" feel.
    setDragY(Math.max(0, e.clientY - dragStartYRef.current));
  }
  function handleDragEnd() {
    if (dragStartYRef.current === null) return;
    dragStartYRef.current = null;
    setDragging(false);
    // A real swipe past the threshold, OR a plain tap (barely moved) — both close, matching the
    // handle's own dual job as a drag grip AND a one-tap "minimise" affordance. Anything in
    // between (started a swipe, didn't commit to it) springs back open instead of closing on a
    // gesture the person may not have intended to complete.
    if (dragY > DISMISS_DISTANCE || dragY < TAP_DISTANCE) {
      onClose();
    }
    setDragY(0);
  }

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
        // Real, live-reported bug this fixes: "I have to click into white space and that's not
        // functional" — a well-known iOS Safari quirk where a plain, non-native-interactive
        // element (a bare <div>) doesn't reliably register tap/click events at all unless it
        // either IS a natively-interactive element or is explicitly marked as one via
        // `cursor: pointer` — WebKit uses that style as one of its own signals for "this is
        // tappable" when deciding whether to fire a synthetic click after a touch. Without it,
        // a tap on this backdrop could be silently swallowed instead of closing the sheet,
        // exactly the intermittent "doesn't work" the report describes.
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(22, 19, 15, 0.5)',
          opacity: open ? 1 : 0,
          transition: 'opacity 0.2s ease',
          cursor: 'pointer',
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
          // Real, live-reported bug this fixes ("the box at top is cut off and doesn't look
          // aligned"): top padding used to live here (10px) and get cancelled out by a matching
          // negative top margin on the handle bar below, so the handle could sit flush against
          // the panel's rounded top edge. That negative-margin/sticky combination measured out
          // fine in isolation but, once this panel actually had a `position: sticky` handle
          // sitting inside a `overflow-y: auto` scroll container, resolved a few px short of the
          // handle's own margin-bottom — the very next element (a step's heading, e.g. "Send
          // ... to...") started rendering UNDER the still-opaque, higher-stacking-order handle
          // bar, clipping its top few pixels. Moving the "flush to the top edge" job onto the
          // padding itself (0, not 10, with the handle providing its own clean marginBottom
          // below) reaches the identical flush-top visual without any negative-margin trick for
          // a sticky element's positioning to fight — content after it now reliably clears the
          // handle by exactly its own margin, not an emergent, easy-to-regress number.
          padding: '0 20px calc(env(safe-area-inset-bottom, 0px) + 20px)',
          // While actively dragging, the panel follows the finger exactly (dragY, no easing —
          // any transition lag here would read as laggy/disconnected from the touch); once
          // released, the normal eased transition takes back over for both the "spring back
          // open" and the "finish sliding closed" cases.
          transform: open ? `translateY(${dragY}px)` : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 0.25s cubic-bezier(.32,.72,0,1)',
          boxShadow: 'var(--v2-shadow-lg)',
          outline: 'none',
        }}
      >
        {/* The drag handle — now an actual one, not just a button styled to look like one (the
            live complaint this fixes: "I hate the feel of it right now"). Also still a one-tap
            close: handleDragEnd treats a barely-moved press the same as a real swipe past the
            threshold. `touchAction: 'none'` stops the browser's own pull-to-refresh/scroll
            gesture from competing with the drag on mobile. */}
        <div
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          role="button"
          aria-label="Drag down or tap to close"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%',
            padding: '14px 0 10px', margin: '0 0 4px', position: 'sticky', top: 0, zIndex: 2,
            background: 'var(--v2-surface)', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none',
          }}
        >
          <span style={{ width: 36, height: 4, borderRadius: 4, background: 'var(--v2-ink-dim)', opacity: 0.4 }} />
        </div>
        {/* A second, unmistakable close affordance — the live complaint this fixes: "show a
            minimise button". The handle above does the same job, but reads as a passive visual
            indicator rather than a button; this is never ambiguous. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="v2-tap-feedback"
          style={{
            position: 'absolute', top: 10, right: 16, zIndex: 3, width: 30, height: 30, borderRadius: '50%',
            border: 'none', background: 'var(--v2-bg-deep)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', color: 'var(--v2-ink)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l12 12M16 4 4 16" /></svg>
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
