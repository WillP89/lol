'use client';

import { useState } from 'react';
import { IdentityPicker } from '@/components/IdentityPicker';

/**
 * The tap target that opens the real identity experience (components/IdentityPicker.tsx) — a
 * photo, a Plot Character / Plot Art theme, or the plain generated mark. Wraps whatever identity
 * visual is passed as `children` (a PersonAvatar or CrewMark, which already reflects the current
 * `value`) with a tap target and a small pencil badge.
 */
export function MediaUploadButton({
  uploadPath,
  deletePath,
  onChange,
  shape = 'circle',
  size,
  presetKind,
  value,
  name,
  email,
  children,
}: {
  uploadPath: string;
  deletePath: string;
  onChange: (url: string | null) => void;
  shape?: 'circle' | 'squircle';
  size: number;
  presetKind?: 'avatar' | 'crew';
  /** The current avatarUrl/imageUrl — real photo, a `plot-avatar:`/`plot-crew-art:` marker, or
   * null — so the picker opens already reflecting reality, not a blank slate. */
  value?: string | null;
  /** Person's display name (or Crew name) — used for initials and as the identity-colour seed. */
  name?: string;
  /** Person's email — a stronger, stabler identity-colour seed than name when available. */
  email?: string;
  children: React.ReactNode;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div style={{ display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="v2-tap-feedback"
        style={{ position: 'relative', border: 'none', background: 'none', padding: 0, cursor: 'pointer', borderRadius: shape === 'circle' ? '50%' : Math.round(size * 0.28) }}
        aria-label="Change photo"
      >
        {children}
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

      <IdentityPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        kind={presetKind ?? 'avatar'}
        uploadPath={uploadPath}
        deletePath={deletePath}
        name={name ?? ''}
        email={email}
        value={value ?? null}
        onChange={onChange}
      />
    </div>
  );
}
