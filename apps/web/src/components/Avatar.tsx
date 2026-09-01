'use client';

import { identityGradient, initialsOf, crewInitial } from '@/lib/identity';

/**
 * The two identity primitives used everywhere a person or a Crew is shown — replacing five
 * separate copy-pasted "flat circle + one initial" implementations (Home, Crews, Crew chat,
 * Profile, invite preview each had their own). Two deliberate, learnable shapes instead of one:
 * a PERSON is a circle, a CREW is a squircle (rounded square) — the same grammar maps/design
 * systems use for pins vs. areas. Once you know it, you can tell a person from a group at a
 * glance without reading anything. See docs/DECISIONS.md#plot-brand-system.
 *
 * Both fall back to the identity-gradient system (lib/identity.ts) when there's no photo, and
 * both accept a real photo URL once upload exists (components/AvatarUpload.tsx) — never a bare
 * grey circle.
 */

export function PersonAvatar({
  name,
  email,
  photoUrl,
  size = 36,
  ring = false,
}: {
  name: string | null;
  email: string;
  photoUrl?: string | null;
  size?: number;
  ring?: boolean;
}) {
  const seed = email || name || 'plot';
  const initials = initialsOf(name, email);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        position: 'relative',
        background: photoUrl ? undefined : identityGradient(seed),
        boxShadow: ring ? '0 0 0 2px var(--v2-surface), 0 0 0 3.5px rgba(12,12,13,0.14)' : 'none',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {photoUrl ? (
        <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <span
          style={{
            fontFamily: "'Archivo', ui-sans-serif, system-ui, sans-serif",
            fontWeight: 800,
            fontSize: size * 0.38,
            color: 'rgba(255,255,255,0.92)',
            letterSpacing: '-0.02em',
          }}
        >
          {initials}
        </span>
      )}
    </div>
  );
}

/** A squircle (~28% corner radius) — Plot's shape for a Crew, distinct from a person's circle. */
export function CrewMark({
  name,
  imageUrl,
  size = 44,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
}) {
  const radius = Math.round(size * 0.28);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        background: imageUrl ? undefined : identityGradient(name),
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <>
          {/* The "gathering" motif — three converging points, the same family as IconLock/
              IconGathering — watermarked large and off-center, so even a default Crew mark
              carries Plot's own geometry rather than being an empty gradient tile. */}
          <svg
            width={size}
            height={size}
            viewBox="0 0 20 20"
            style={{ position: 'absolute', top: 0, left: 0, opacity: 0.22 }}
          >
            <circle cx="14.5" cy="5" r="2.1" fill="white" />
            <circle cx="17.5" cy="10.5" r="1.3" fill="white" />
            <circle cx="12" cy="9.5" r="1.3" fill="white" />
          </svg>
          <span
            style={{
              position: 'relative',
              fontFamily: "'Archivo', ui-sans-serif, system-ui, sans-serif",
              fontWeight: 800,
              fontSize: size * 0.42,
              color: 'rgba(255,255,255,0.94)',
              letterSpacing: '-0.02em',
              padding: `0 0 ${Math.round(size * 0.06)}px ${Math.round(size * 0.1)}px`,
            }}
          >
            {crewInitial(name)}
          </span>
        </>
      )}
    </div>
  );
}
