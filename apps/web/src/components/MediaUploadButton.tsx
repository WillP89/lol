'use client';

import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * The real upload flow behind both avatar and Crew-image editing — choose, preview, upload,
 * replace, remove, with real validation and failure recovery (brief: "not an admin form").
 * Wraps whatever identity visual is passed as `children` (a PersonAvatar or CrewMark) with a
 * tap target and a small pencil badge; the visual itself always reflects the current state
 * (photo, or the identity-gradient fallback) since `photoUrl` lives in the parent.
 */
export function MediaUploadButton({
  uploadPath,
  deletePath,
  onChange,
  shape = 'circle',
  size,
  children,
}: {
  uploadPath: string;
  deletePath: string;
  onChange: (url: string | null) => void;
  shape?: 'circle' | 'squircle';
  size: number;
  children: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasPhoto, setHasPhoto] = useState(false);

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
    setStatus('uploading');
    setError(null);
    try {
      const body = await api.upload<{ avatarUrl?: string; imageUrl?: string }>(uploadPath, file);
      const url = body.avatarUrl ?? body.imageUrl ?? null;
      setHasPhoto(Boolean(url));
      onChange(url);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Upload failed — try again.');
    }
  }

  async function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    setStatus('uploading');
    try {
      await api.delete(deletePath);
      setHasPhoto(false);
      onChange(null);
      setStatus('idle');
    } catch {
      setStatus('error');
      setError('Could not remove — try again.');
    }
  }

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="v2-tap-feedback"
        style={{ position: 'relative', border: 'none', background: 'none', padding: 0, cursor: 'pointer', borderRadius: shape === 'circle' ? '50%' : Math.round(size * 0.28) }}
        aria-label="Change photo"
      >
        <div style={{ opacity: status === 'uploading' ? 0.5 : 1, transition: 'opacity 0.15s ease' }}>{children}</div>
        {status === 'uploading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="v2-spinner" style={{ width: size * 0.28, height: size * 0.28 }} />
          </div>
        )}
        <span
          style={{
            position: 'absolute', bottom: -2, right: -2, width: 26, height: 26, borderRadius: '50%',
            background: 'var(--v2-brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2.5px solid var(--v2-surface)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 3.5 16.5 6.5 6.5 16.5 3 17l.5-3.5Z" />
          </svg>
        </span>
      </button>
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
      {hasPhoto && status !== 'uploading' && (
        <button type="button" onClick={handleRemove} className="v2-muted" style={{ fontSize: 11.5, fontWeight: 700, border: 'none', background: 'none', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>
          Remove photo
        </button>
      )}
      {error && <span style={{ fontSize: 11.5, color: 'var(--v2-error)', maxWidth: 160, textAlign: 'center' }}>{error}</span>}
    </div>
  );
}
