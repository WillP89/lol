'use client';

import { useEffect } from 'react';

/**
 * A real sliding-up sheet with a backdrop, matching the demo's `.sheet` pattern — used
 * wherever the app needs a focused choice (which Crew to send this to) without leaving the
 * current screen. Dismissible by tapping the backdrop, not just an explicit Cancel button.
 *
 * `variant` picks which palette the sheet itself renders in — independent of whichever design
 * system the page around it uses, since this component is shared by both. Real bug this fixed:
 * every v2 page using this (Crew chat's "+" sheet and Crew-info sheet, Explore's filter sheet)
 * still got the old hardcoded dark `--ink-surface` panel sliding up over an otherwise light v2
 * page — the CSS variable resolved fine either way (both are defined on `:root`), it just
 * always resolved to the *wrong* palette for a v2 context. Defaults to 'dark' so every existing
 * old-system caller (Crews list, Profile) needs no change.
 */
export function BottomSheet({
  open,
  onClose,
  children,
  variant = 'dark',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  variant?: 'dark' | 'light';
}) {
  // The light variant gets a frosted-glass surface (backdrop-filter) instead of flat white —
  // overlay chrome (sheets, the floating nav) reads as a real material this way; content
  // surfaces (cards) stay solid so text inside them keeps full contrast.
  const surface = variant === 'light' ? 'rgba(255, 255, 255, 0.86)' : 'var(--ink-surface)';
  const border = variant === 'light' ? 'var(--v2-line)' : 'var(--ink-border)';
  const handle = variant === 'light' ? 'var(--v2-ink-dim)' : 'var(--ink-border)';
  const radius = variant === 'light' ? 'var(--v2-r-lg) var(--v2-r-lg) 0 0' : '20px 20px 0 0';
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

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: open ? 'block' : 'none',
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          opacity: open ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxWidth: variant === 'light' ? 560 : 480,
          margin: '0 auto',
          background: surface,
          borderTop: `1px solid ${border}`,
          borderRadius: radius,
          // Real bug, confirmed via a live screenshot on a real (non-maximised, not full-height)
          // browser window: with no max-height, tall content (an event's image + description +
          // button) got cut off at the bottom of the viewport with no way to scroll to it —
          // "Share to Crew" was rendered entirely off-screen. maxHeight + its own scroll means
          // the sheet now always fits, however short the window is; the drag handle and any
          // sticky footer content inside `children` stay reachable by scrolling the sheet itself.
          maxHeight: 'calc(100dvh - 40px)',
          overflowY: 'auto',
          padding: '10px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)',
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.25s cubic-bezier(.32,.72,0,1)',
          boxShadow: variant === 'light' ? 'var(--v2-shadow-lg)' : '0 -20px 40px -12px rgba(0,0,0,0.5)',
          ...(variant === 'light' ? { backdropFilter: 'blur(24px) saturate(1.6)', WebkitBackdropFilter: 'blur(24px) saturate(1.6)' } : {}),
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 4, background: handle, margin: '4px auto 14px', opacity: variant === 'light' ? 0.35 : 1, position: 'sticky', top: 0 }} />
        {children}
      </div>
    </div>
  );
}
