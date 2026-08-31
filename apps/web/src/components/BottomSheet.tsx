'use client';

import { useEffect, useRef } from 'react';

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
 */
export function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

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
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: open ? 'flex' : 'none',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      className="v2-sheet-root"
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
    </div>
  );
}
