'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '@/lib/api';
import { identityGradient, initialsOf, crewInitial } from '@/lib/identity';
import { PLOT_AVATARS, PLOT_AVATAR_PREFIX } from '@/components/PlotAvatars';
import { CREW_ART_THEME_IDS, CREW_ART_PREFIX, crewArtStyle, crewArtLabel } from '@/lib/crewArt';

/**
 * The real "how do I show up in Plot" experience — replacing a title/grid/save-button sheet
 * that read as a dev feature, not a piece of a premium consumer product. One big, alive preview
 * of whatever's currently focused, a touch-native strip of every real choice (your own photo,
 * a Plot Character / Plot Art theme, or the plain generated identity mark) underneath it, and
 * instant, tactile selection — no separate "confirm" step for a preset, because there's nothing
 * to confirm: tapping it already applied it (optimistic, same as the old flow), the sheet is
 * just where you keep browsing or leave from. See docs/DECISIONS.md#plot-identity-picker.
 */
export function IdentityPicker({
  open,
  onClose,
  kind,
  uploadPath,
  deletePath,
  name,
  email,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  kind: 'avatar' | 'crew';
  uploadPath: string;
  deletePath: string;
  name: string;
  email?: string;
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const prefix = kind === 'avatar' ? PLOT_AVATAR_PREFIX : CREW_ART_PREFIX;
  const presetId = value?.startsWith(prefix) ? value.slice(prefix.length) : null;
  const hasRealPhoto = Boolean(value && !presetId);

  type Focus = { kind: 'upload' } | { kind: 'preset'; id: string } | { kind: 'classic' };
  const [focus, setFocus] = useState<Focus>(presetId ? { kind: 'preset', id: presetId } : hasRealPhoto ? { kind: 'upload' } : { kind: 'classic' });
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Re-sync to whatever's actually saved every time the sheet opens — never trust stale local
  // state if it was opened, closed, and reopened without a remount.
  useEffect(() => {
    if (!open) return;
    setFocus(presetId ? { kind: 'preset', id: presetId } : hasRealPhoto ? { kind: 'upload' } : { kind: 'classic' });
    setStatus('idle');
    setError(null);
    // Intentionally re-syncs only on `open` — presetId/hasRealPhoto are derived from `value`
    // each render, and re-running this on every value change would fight the user's in-sheet
    // selection while it's open.
  }, [open]); // eslint-disable-line

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  const options = kind === 'avatar' ? PLOT_AVATARS.map((a) => ({ id: a.id, label: a.label })) : CREW_ART_THEME_IDS.map((id) => ({ id, label: crewArtLabel(id) }));

  async function handleFile(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setStatus('error');
      setError('Use a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setStatus('error');
      setError('That image is too large — under 6MB, please.');
      return;
    }
    setStatus('busy');
    setError(null);
    try {
      const body = await api.upload<{ avatarUrl?: string; imageUrl?: string }>(uploadPath, file);
      const url = body.avatarUrl ?? body.imageUrl ?? null;
      setFocus({ kind: 'upload' });
      onChange(url);
      setStatus('idle');
      onClose();
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Upload failed — try again.');
    }
  }

  async function choosePreset(id: string) {
    const previous = focus;
    setFocus({ kind: 'preset', id });
    setStatus('busy');
    setError(null);
    try {
      const body = await api.post<{ avatarUrl?: string; imageUrl?: string }>(
        `${uploadPath}/preset`,
        kind === 'crew' ? { themeId: id } : { presetId: id },
      );
      const url = body.avatarUrl ?? body.imageUrl ?? null;
      onChange(url);
      setStatus('idle');
    } catch (err) {
      setFocus(previous);
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Could not set that — try again.');
    }
  }

  async function chooseClassic() {
    if (focus.kind === 'classic') return;
    const previous = focus;
    setFocus({ kind: 'classic' });
    setStatus('busy');
    setError(null);
    try {
      await api.delete(deletePath);
      onChange(null);
      setStatus('idle');
    } catch {
      setFocus(previous);
      setStatus('error');
      setError('Could not clear — try again.');
    }
  }

  const isCircle = kind === 'avatar';
  const initials = kind === 'avatar' ? initialsOf(name || null, email || 'plot') : crewInitial(name || 'Plot');
  const heroKey = focus.kind === 'preset' ? `preset:${focus.id}` : focus.kind;

  return createPortal(
    // "v2" (not just "v2-sheet-root") re-establishes Plot's --v2-* custom-property set at this
    // portal root — see the identical comment in BottomSheet.tsx for why a portal to
    // document.body needs it: those variables are scoped to the `.v2` class, and a portal target
    // is a DOM sibling of the page's `.v2` wrapper, not a descendant, so nothing here could
    // resolve them without redeclaring the class fresh right here.
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: open ? 'flex' : 'none', alignItems: 'flex-end', justifyContent: 'center' }} className="v2 v2-sheet-root">
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'rgba(18,15,12,0.58)', opacity: open ? 1 : 0, transition: 'opacity 0.2s ease' }}
      />
      <div
        className="v2-sheet-panel"
        role="dialog"
        aria-modal="true"
        style={{
          position: 'relative',
          width: '100%',
          background: 'var(--v2-surface)',
          maxHeight: 'calc(100dvh - 32px)',
          overflowY: 'auto',
          padding: '10px 20px calc(env(safe-area-inset-bottom, 0px) + 22px)',
          boxShadow: 'var(--v2-shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px' }}>
          <span style={{ width: 36, height: 4, borderRadius: 4, background: 'var(--v2-ink-dim)', opacity: 0.4 }} />
        </div>

        <div className="v2-eyebrow" style={{ textAlign: 'center', marginTop: 8 }}>{kind === 'avatar' ? 'Your identity' : 'Crew identity'}</div>
        <h2 className="v2-display" style={{ fontSize: 20, textAlign: 'center', margin: '2px 0 20px' }}>
          {kind === 'avatar' ? 'Pick how you show up' : `Give ${name || 'your Crew'} a look`}
        </h2>

        {/* Hero — the single large, alive preview of whatever's currently focused. Keyed so React
            remounts it on every change and the settle animation replays fresh each time. */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
          <div
            key={heroKey}
            className="v2-identity-hero"
            style={{
              width: 128,
              height: 128,
              borderRadius: isCircle ? '50%' : 32,
              overflow: 'hidden',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 14px 30px rgba(20,16,12,0.22)',
              background:
                focus.kind === 'preset' && kind === 'crew'
                  ? crewArtStyle(focus.id)
                  : focus.kind === 'classic' || (focus.kind === 'upload' && !hasRealPhoto)
                    ? identityGradient(email || name || 'plot')
                    : undefined,
              backgroundSize: 'cover',
            }}
          >
            {focus.kind === 'preset' && kind === 'avatar' && (
              <svg width="100%" height="100%" viewBox="0 0 40 40">{PLOT_AVATARS.find((a) => a.id === focus.id)?.render()}</svg>
            )}
            {focus.kind === 'classic' && (
              <span style={{ fontFamily: "'Archivo', ui-sans-serif, system-ui, sans-serif", fontWeight: 800, fontSize: 42, color: 'rgba(255,255,255,0.95)', letterSpacing: '-0.02em' }}>
                {initials}
              </span>
            )}
            {focus.kind === 'upload' && (hasRealPhoto && value ? (
              <img src={value} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 42, color: 'rgba(255,255,255,0.95)' }}>{initials}</span>
            ))}

            {status === 'busy' && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,8,6,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="v2-spinner" style={{ width: 28, height: 28 }} />
              </div>
            )}
          </div>
        </div>

        {error && <p style={{ textAlign: 'center', color: 'var(--v2-error)', fontSize: 12.5, marginBottom: 14 }}>{error}</p>}

        <div className="v2-identity-strip">
          <button type="button" className={`v2-identity-tile v2-tap-feedback${focus.kind === 'upload' ? ' v2-identity-tile-active' : ''}`} onClick={() => inputRef.current?.click()}>
            <div
              className="v2-identity-tile-art"
              style={{
                borderRadius: isCircle ? '50%' : 16,
                background: hasRealPhoto && value ? `url("${value}") center/cover` : 'var(--v2-bg-deep)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {!(hasRealPhoto && value) && (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--v2-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="3" />
                  <circle cx="12" cy="12" r="3.2" />
                  <path d="M8 5 9.3 3h5.4L16 5" />
                </svg>
              )}
            </div>
            <span className="v2-identity-tile-label">Your photo</span>
          </button>

          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`v2-identity-tile v2-tap-feedback${focus.kind === 'preset' && focus.id === opt.id ? ' v2-identity-tile-active' : ''}`}
              onClick={() => choosePreset(opt.id)}
            >
              <div className="v2-identity-tile-art" style={{ borderRadius: isCircle ? '50%' : 16, overflow: 'hidden' }}>
                {kind === 'avatar' ? (
                  <svg width="100%" height="100%" viewBox="0 0 40 40">{PLOT_AVATARS.find((a) => a.id === opt.id)?.render()}</svg>
                ) : (
                  <div style={{ width: '100%', height: '100%', background: crewArtStyle(opt.id), backgroundSize: 'cover' }} />
                )}
              </div>
              <span className="v2-identity-tile-label">{opt.label}</span>
            </button>
          ))}

          <button type="button" className={`v2-identity-tile v2-tap-feedback${focus.kind === 'classic' ? ' v2-identity-tile-active' : ''}`} onClick={chooseClassic}>
            <div
              className="v2-identity-tile-art"
              style={{ borderRadius: isCircle ? '50%' : 16, background: identityGradient(email || name || 'plot'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 14, color: '#fff' }}>{initials}</span>
            </div>
            <span className="v2-identity-tile-label">Classic</span>
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />

        <button type="button" className="v2-btn v2-btn-brand v2-tap-feedback" style={{ width: '100%', marginTop: 20 }} onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
