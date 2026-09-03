'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '@/lib/api';
import { identityGradient, initialsOf, crewInitial } from '@/lib/identity';
import { PLOT_AVATARS, PLOT_AVATAR_PREFIX } from '@/components/PlotAvatars';
import { CREW_ART_THEME_IDS, CREW_ART_PREFIX, crewArtStyle, crewArtLabel } from '@/lib/crewArt';

// Matches lib/imageDimensions.ts's own MIN_IMAGE_WIDTH exactly — the app's own real HD floor, so
// resizing down to this is never a quality downgrade anywhere the result actually gets shown.
const MAX_UPLOAD_DIMENSION = 1600;
const UPLOAD_JPEG_QUALITY = 0.85;

/** Shrinks a photo client-side, before the upload even starts — see handleFile's own comment for
 *  the real complaint this fixes. Fails safe: any decode/canvas problem (an odd format, an old
 *  browser, a security-restricted canvas) just returns the original file untouched rather than
 *  blocking the upload on an optimisation that didn't work out. */
async function resizeForUpload(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  try {
    const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file; // already at or under the floor — nothing to gain from re-encoding

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, UPLOAD_JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file; // the re-encode didn't actually help — keep the original
    return new File([blob], file.name, { type: file.type });
  } finally {
    bitmap.close();
  }
}

/**
 * The real "how do I show up in Plot" experience — a full-screen takeover, not a sheet with a
 * title/grid/save-button (the thing that read as a dev feature, not a piece of a premium
 * consumer product — the brief's own verdict, twice). Every real choice — your own photo, a
 * Plot Character, a Plot Art theme, or the plain generated mark — is a full-bleed slide in a
 * swipeable carousel: one thing at a time, filling the screen, the way you'd flip through a
 * stack of real cards rather than scan a grid of thumbnails. The centred slide gets its own
 * "focus" treatment (scaled up, full opacity; neighbours recede) so browsing itself feels alive
 * before you've even tapped anything. See docs/DECISIONS.md#plot-identity-picker.
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
  const trackRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const prefix = kind === 'avatar' ? PLOT_AVATAR_PREFIX : CREW_ART_PREFIX;
  const presetId = value?.startsWith(prefix) ? value.slice(prefix.length) : null;
  const hasRealPhoto = Boolean(value && !presetId);
  const isCircle = kind === 'avatar';
  const initials = kind === 'avatar' ? initialsOf(name || null, email || 'plot') : crewInitial(name || 'Plot');

  type Slide = { kind: 'photo' } | { kind: 'preset'; id: string; label: string } | { kind: 'classic' };
  const slides: Slide[] = [
    { kind: 'photo' },
    ...(kind === 'avatar' ? PLOT_AVATARS.map((a) => ({ kind: 'preset' as const, id: a.id, label: a.label })) : CREW_ART_THEME_IDS.map((id) => ({ kind: 'preset' as const, id, label: crewArtLabel(id) }))),
    { kind: 'classic' },
  ];
  const initialIndex = presetId ? slides.findIndex((s) => s.kind === 'preset' && s.id === presetId) : hasRealPhoto ? 0 : slides.length - 1;

  const [activeIndex, setActiveIndex] = useState(Math.max(0, initialIndex));
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Re-sync to whatever's actually saved + scroll to it every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    const idx = Math.max(0, initialIndex);
    setActiveIndex(idx);
    setStatus('idle');
    setError(null);
    const raf = requestAnimationFrame(() => {
      const track = trackRef.current;
      const slideEl = track?.children[idx] as HTMLElement | undefined;
      if (track && slideEl) track.scrollLeft = slideEl.offsetLeft - (track.clientWidth - slideEl.clientWidth) / 2;
    });
    return () => cancelAnimationFrame(raf);
    // Intentionally re-syncs only on `open` — initialIndex is derived from `value` each render,
    // and re-running this on every value change would fight the user's in-carousel browsing
    // while it's open.
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

  function handleScroll() {
    const track = trackRef.current;
    if (!track) return;
    let closest = 0;
    let closestDist = Infinity;
    Array.from(track.children).forEach((child, i) => {
      const el = child as HTMLElement;
      const dist = Math.abs(el.offsetLeft + el.clientWidth / 2 - (track.scrollLeft + track.clientWidth / 2));
      if (dist < closestDist) { closestDist = dist; closest = i; }
    });
    setActiveIndex(closest);
  }

  function scrollTo(idx: number) {
    const track = trackRef.current;
    const slideEl = track?.children[idx] as HTMLElement | undefined;
    if (track && slideEl) track.scrollTo({ left: slideEl.offsetLeft - (track.clientWidth - slideEl.clientWidth) / 2, behavior: 'smooth' });
  }

  async function handleFile(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setStatus('error');
      setError('Use a JPEG, PNG, or WebP image.');
      return;
    }
    setStatus('busy');
    setError(null);
    try {
      // Real, live complaint this fixes: uploading felt slow, not instant — a modern phone photo
      // is routinely 3-8MB at 3000px+ wide, almost none of which the app ever actually shows:
      // even Home's own hero, the single biggest image placement anywhere in Plot, only ever
      // needs ~1600px to render crisp (see lib/imageDimensions.ts's own comment on that exact
      // math — same number, reused here). Shrinking client-side, before the upload even starts,
      // cuts the real bytes travelling over a mobile connection by several times, with zero
      // visible quality loss anywhere the result is actually displayed. Resizing FIRST, then
      // checking the resulting size against the 6MB cap (rather than rejecting the original
      // upfront) also means a big-but-shrinkable photo now succeeds instead of being turned away
      // for being "too large" when resizing alone would have easily solved it.
      const upload = await resizeForUpload(file);
      if (upload.size > 6 * 1024 * 1024) {
        setStatus('error');
        setError('That image is too large — under 6MB, please.');
        return;
      }
      const body = await api.upload<{ avatarUrl?: string; imageUrl?: string }>(uploadPath, upload);
      const url = body.avatarUrl ?? body.imageUrl ?? null;
      onChange(url);
      setStatus('idle');
      onClose();
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Upload failed — try again.');
    }
  }

  async function commitActive() {
    const slide = slides[activeIndex];
    if (slide.kind === 'photo') {
      inputRef.current?.click();
      return;
    }
    setStatus('busy');
    setError(null);
    try {
      if (slide.kind === 'preset') {
        const body = await api.post<{ avatarUrl?: string; imageUrl?: string }>(
          `${uploadPath}/preset`,
          kind === 'crew' ? { themeId: slide.id } : { presetId: slide.id },
        );
        onChange(body.avatarUrl ?? body.imageUrl ?? null);
      } else {
        await api.delete(deletePath);
        onChange(null);
      }
      setStatus('idle');
      onClose();
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Could not set that — try again.');
    }
  }

  const activeSlide = slides[activeIndex];
  const ctaLabel =
    activeSlide.kind === 'photo' ? 'Choose a photo' : activeSlide.kind === 'classic' ? 'Use the classic mark' : `Choose ${activeSlide.label}`;

  return createPortal(
    <div
      className="v2"
      style={{
        position: 'fixed', inset: 0, zIndex: 200, display: open ? 'flex' : 'none', flexDirection: 'column',
        background: 'var(--v2-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px calc(env(safe-area-inset-top, 0px))', paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))' }}>
        <button type="button" onClick={onClose} aria-label="Close" className="v2-tap-feedback" style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'var(--v2-bg-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--v2-ink)' }}>
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l12 12M16 4 4 16" /></svg>
        </button>
        <div style={{ textAlign: 'center' }}>
          <div className="v2-eyebrow" style={{ marginBottom: 0 }}>{kind === 'avatar' ? 'Your identity' : 'Crew identity'}</div>
        </div>
        <div style={{ width: 36 }} />
      </div>

      <h2 className="v2-display" style={{ fontSize: 24, textAlign: 'center', margin: '2px 20px 18px' }}>
        {kind === 'avatar' ? 'Pick how you show up' : `Give ${name || 'your Crew'} a look`}
      </h2>

      {error && <p style={{ textAlign: 'center', color: 'var(--v2-error)', fontSize: 12.5, marginBottom: 8, padding: '0 20px' }}>{error}</p>}

      {/* The carousel — one slide fills nearly the whole width, neighbours peek at the edges as
          the swipe affordance. The centred slide gets its own "focus" treatment (full scale/
          opacity; everything else recedes) so just browsing feels alive. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center' }}>
        <div
          ref={trackRef}
          onScroll={handleScroll}
          style={{
            display: 'flex', gap: 16, overflowX: 'auto', scrollSnapType: 'x mandatory', width: '100%', height: '100%',
            padding: '0 12vw', alignItems: 'center', scrollbarWidth: 'none',
          }}
          className="v2-identity-track"
        >
          {slides.map((slide, i) => {
            const active = i === activeIndex;
            // A person's badge must stay a true circle regardless of the carousel's own
            // portrait-ish aspect ratio — sized off width with aspectRatio:1 rather than
            // stretched to fill the track's height, which a plain height:68% would do. Crew art
            // stays a tall poster-shaped card (its actual finished look everywhere else in the
            // app), so it keeps filling the available height.
            const commonStyle: React.CSSProperties = isCircle
              ? {
                  flex: '0 0 68%', maxWidth: 280, aspectRatio: '1', scrollSnapAlign: 'center', borderRadius: '50%',
                  position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transform: active ? 'scale(1)' : 'scale(0.82)', opacity: active ? 1 : 0.45,
                  transition: 'transform 0.3s cubic-bezier(.2,.8,.2,1), opacity 0.3s ease',
                  boxShadow: active ? '0 20px 44px rgba(20,16,12,0.28)' : 'none', cursor: 'pointer',
                }
              : {
                  flex: '0 0 76%', maxWidth: 340, height: '68%', scrollSnapAlign: 'center', borderRadius: 28,
                  position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transform: active ? 'scale(1)' : 'scale(0.84)', opacity: active ? 1 : 0.45,
                  transition: 'transform 0.3s cubic-bezier(.2,.8,.2,1), opacity 0.3s ease',
                  boxShadow: active ? '0 20px 44px rgba(20,16,12,0.28)' : 'none', cursor: 'pointer',
                };
            if (slide.kind === 'photo') {
              return (
                <button
                  key="photo"
                  type="button"
                  onClick={() => (active ? inputRef.current?.click() : scrollTo(i))}
                  style={{ ...commonStyle, border: 'none', background: hasRealPhoto && value ? `url("${value}") center/cover` : 'var(--v2-bg-deep)' }}
                >
                  {!(hasRealPhoto && value) && (
                    <svg width="20%" height="20%" viewBox="0 0 24 24" fill="none" stroke="var(--v2-ink-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="12" cy="12" r="3.4" /><path d="M8 5l1.5-2h5L16 5" />
                    </svg>
                  )}
                  <span style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 13, fontWeight: 800, color: hasRealPhoto ? '#fff' : 'var(--v2-ink)', textShadow: hasRealPhoto ? '0 1px 4px rgba(0,0,0,0.5)' : 'none' }}>Your photo</span>
                </button>
              );
            }
            if (slide.kind === 'classic') {
              return (
                <button
                  key="classic"
                  type="button"
                  onClick={() => (active ? commitActive() : scrollTo(i))}
                  style={{ ...commonStyle, border: 'none', background: identityGradient(email || name || 'plot') }}
                >
                  <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 56, color: 'rgba(255,255,255,0.95)' }}>{initials}</span>
                  <span style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 13, fontWeight: 800, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.4)' }}>Classic</span>
                </button>
              );
            }
            // preset
            return (
              <button
                key={slide.id}
                type="button"
                onClick={() => (active ? commitActive() : scrollTo(i))}
                style={{ ...commonStyle, border: 'none', background: kind === 'crew' ? crewArtStyle(slide.id) : 'transparent', backgroundSize: 'cover' }}
              >
                {kind === 'avatar' && (
                  <svg width="100%" height="100%" viewBox="0 0 40 40">{PLOT_AVATARS.find((a) => a.id === slide.id)?.render()}</svg>
                )}
                <span style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 13, fontWeight: 800, color: kind === 'crew' ? '#fff' : 'var(--v2-ink)', textShadow: kind === 'crew' ? '0 1px 4px rgba(0,0,0,0.4)' : 'none' }}>
                  {slide.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Desktop-friendly prev/next — swipe is the mobile-native gesture, but a mouse has no
            swipe, so these give the same browsing motion a click. */}
        <button type="button" onClick={() => scrollTo(Math.max(0, activeIndex - 1))} aria-label="Previous" className="v2-tap-feedback" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 38, height: 38, borderRadius: '50%', border: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', display: activeIndex > 0 ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--v2-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4 6 10l6 6" /></svg>
        </button>
        <button type="button" onClick={() => scrollTo(Math.min(slides.length - 1, activeIndex + 1))} aria-label="Next" className="v2-tap-feedback" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 38, height: 38, borderRadius: '50%', border: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', display: activeIndex < slides.length - 1 ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--v2-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4l6 6-6 6" /></svg>
        </button>
      </div>

      {/* Position dots — a light, real signal of "there's more, and here's where you are",
          not decoration; capped/condensed for a long strip so it never wraps. */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '10px 0 4px' }}>
        {slides.map((_, i) => (
          <div key={i} style={{ width: i === activeIndex ? 16 : 5, height: 5, borderRadius: 3, background: i === activeIndex ? 'var(--v2-brand)' : 'var(--v2-bg-deep)', transition: 'width 0.2s ease, background 0.2s ease' }} />
        ))}
      </div>

      <div style={{ padding: '10px 20px calc(env(safe-area-inset-bottom, 0px) + 18px)' }}>
        <button type="button" onClick={commitActive} disabled={status === 'busy'} className="v2-btn v2-btn-brand v2-tap-feedback" style={{ width: '100%', opacity: status === 'busy' ? 0.6 : 1 }}>
          {status === 'busy' ? 'Saving…' : ctaLabel}
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
    </div>,
    document.body,
  );
}
