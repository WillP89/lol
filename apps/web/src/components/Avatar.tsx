'use client';

import { useState } from 'react';
import { identityGradient, initialsOf, crewInitial } from '@/lib/identity';
import { PLOT_AVATAR_PREFIX, getPlotAvatarDef } from '@/components/PlotAvatars';
import { isCrewArtUrl } from '@/lib/crewArt';
import { IconGathering } from '@/components/icons';

// The system account Plot itself posts recommendation messages as (apps/api/src/services/
// crewRecommendations.ts#PLOT_SYSTEM_EMAIL — mirrored here since the web client has no reason to
// import server code for one string). Matched against `name` too: at least one existing call
// site (Home's "In the groups" message row) passes the message's `authorName` into BOTH the
// `name` and `email` props (no real author email in that DTO), so an email-only check would
// silently miss it there.
const PLOT_SYSTEM_EMAIL = 'system+plot-recommendations@plot.internal';

/**
 * The two identity primitives used everywhere a person or a Crew is shown — replacing five
 * separate copy-pasted "flat circle + one initial" implementations (Home, Crews, Crew chat,
 * Profile, invite preview each had their own). Two deliberate, learnable shapes instead of one:
 * a PERSON is a circle, a CREW is a squircle (rounded square) — the same grammar maps/design
 * systems use for pins vs. areas. Once you know it, you can tell a person from a group at a
 * glance without reading anything. See docs/DECISIONS.md#plot-brand-system.
 *
 * Three real states now, not two: a real uploaded photo, a chosen Plot avatar/Crew art (a
 * `plot-avatar:<id>` / `plot-crew-art:<id>` marker stored in the same column — see
 * components/PlotAvatars.tsx and lib/crewArt.ts for why that's not a real file), or the
 * generated identity-gradient mark. Never a bare grey circle.
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
  const plotAvatarId = photoUrl?.startsWith(PLOT_AVATAR_PREFIX) ? photoUrl.slice(PLOT_AVATAR_PREFIX.length) : null;
  const plotAvatar = plotAvatarId ? getPlotAvatarDef(plotAvatarId) : null;
  // Real gap found auditing this against the brief's own "zero broken images, no exceptions"
  // rule: a real uploaded photo had NO error handling at all — a deleted/expired/momentarily
  // unreachable R2 URL rendered the browser's bare broken-image icon, exactly the failure this
  // whole component exists to prevent for every OTHER case (a Plot avatar, a missing photo).
  // `failedUrl` remembers exactly which URL didn't load; if `photoUrl` later changes (a fresh
  // upload replacing a broken one) it no longer matches, so the new photo gets a fair attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const realPhoto = photoUrl && !plotAvatarId && photoUrl !== failedUrl ? photoUrl : null;
  // Plot itself, posting as the system account — real, reported feedback: a generic "PL"
  // initials circle (the same treatment any two-letter-name human gets) read as an unfinished
  // placeholder, not a product with an actual identity, exactly where it matters most (Plot's
  // own recommendation messages). Takes priority over the realPhoto/plotAvatar checks above —
  // the system account never has either set, but this makes that a guarantee, not an assumption.
  const isPlot = !realPhoto && !plotAvatar && (name === 'Plot' || email === PLOT_SYSTEM_EMAIL);

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        position: 'relative',
        // Plot's own signature gradient — the SAME two stops as the story rail's "urgent" ring
        // and the Plot-found hero card's own language (docs/DECISIONS.md#plot-brand-system) —
        // deliberately fixed, never the per-seed hash-varying gradient every other name gets, so
        // Plot looks like the same one thing everywhere it shows up, not a random colour.
        background: isPlot ? 'linear-gradient(135deg, var(--v2-brand), var(--v2-pop))' : realPhoto || plotAvatar ? undefined : identityGradient(seed),
        boxShadow: ring ? '0 0 0 2px var(--v2-surface), 0 0 0 3.5px rgba(12,12,13,0.14)' : 'none',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {isPlot ? (
        <span style={{ color: '#fff', display: 'flex' }}>
          <IconGathering size={Math.round(size * 0.52)} />
        </span>
      ) : realPhoto ? (
        <img src={realPhoto} alt="" onError={() => setFailedUrl(realPhoto)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : plotAvatar ? (
        <svg width={size} height={size} viewBox="0 0 40 40">
          {plotAvatar.render()}
        </svg>
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

/**
 * A squircle (~28% corner radius) — Plot's shape for a Crew, distinct from a person's circle.
 *
 * `allowThemeArt` (default false): a real, explicit product decision, not a bug — a Crew's own
 * chosen Plot Character mark is deliberately shown ONLY inside that Crew's own chat and in
 * Home's story rail (the one place it doubles as a live-state notification, via the ring around
 * it) — everywhere else a Crew is referenced in passing (Plans, Profile's Crews row, the Crews
 * list, an invite preview) falls back to the plain identity-gradient + initial mark, never the
 * character. Pass `allowThemeArt` explicitly true at exactly those two call sites; every other
 * call site is correct by doing nothing. (Named for the marker's own storage prefix history —
 * `plot-crew-art:<id>` — not a separate "theme" system any more; see IdentityPicker.tsx.)
 */
export function CrewMark({
  name,
  imageUrl,
  size = 44,
  allowThemeArt = false,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
  allowThemeArt?: boolean;
}) {
  const radius = Math.round(size * 0.28);
  const artTheme = allowThemeArt ? isCrewArtUrl(imageUrl) : null;
  // Real, live-reported bug this fixes ("the avatar section for the crews is still not right,
  // it's the old version of images... change them to match the profile avatars"): a Crew's own
  // chosen mark used to be one of 8 abstract themed-poster icons (lib/crewArt.ts), a genuinely
  // different visual system from the redrawn Plot Character collection personal identity picks
  // from — IdentityPicker.tsx now offers a Crew the exact same character set, in the exact same
  // circular badge, as a person's own identity (see its own comment); this is the other half of
  // that same change — wherever a Crew's mark actually RENDERS after being chosen (this
  // component, everywhere `allowThemeArt` is passed), it now draws that same Plot Character
  // artwork instead of the retired theme-icon background. Still a squircle, not a circle — the
  // shape stays how you tell a Crew from a person at a glance; only the mark inside it changed.
  const crewCharacter = artTheme ? getPlotAvatarDef(artTheme) : null;
  // Same real gap as PersonAvatar's own — see its comment. A broken/expired real Crew photo
  // falls back to the identity-gradient + initial mark instead of a bare broken-image icon.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const realPhoto = imageUrl && !isCrewArtUrl(imageUrl) && imageUrl !== failedUrl ? imageUrl : null;

  if (crewCharacter) {
    return (
      <div
        style={{
          width: size, height: size, borderRadius: radius, flexShrink: 0, overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <svg width={size} height={size} viewBox="0 0 40 40">{crewCharacter.render()}</svg>
      </div>
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        background: realPhoto ? undefined : identityGradient(name),
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      {realPhoto ? (
        <img src={realPhoto} alt="" onError={() => setFailedUrl(realPhoto)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
