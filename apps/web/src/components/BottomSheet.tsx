'use client';

import { useEffect } from 'react';

/**
 * A real sliding-up sheet with a backdrop, matching the demo's `.sheet` pattern — used
 * wherever the app needs a focused choice (which Crew to send this to) without leaving the
 * current screen. Dismissible by tapping the backdrop, not just an explicit Cancel button.
 */
export function BottomSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
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
          maxWidth: 480,
          margin: '0 auto',
          background: 'var(--ink-surface)',
          borderTop: '1px solid var(--ink-border)',
          borderRadius: '20px 20px 0 0',
          padding: '10px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)',
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.25s cubic-bezier(.32,.72,0,1)',
          boxShadow: '0 -20px 40px -12px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 4, background: 'var(--ink-border)', margin: '4px auto 14px' }} />
        {children}
      </div>
    </div>
  );
}
