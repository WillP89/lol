'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { BottomSheet } from '@/components/BottomSheet';
import { formatPriceFrom } from '@/lib/formatPrice';
import { PersonAvatar } from '@/components/Avatar';
import { MediaUploadButton } from '@/components/MediaUploadButton';

interface ProfileUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  tasteProfile: {
    categoryAffinity: Record<string, number>;
    budgetMaxMinor: number;
    energyPreference: 'LOW' | 'MEDIUM' | 'HIGH';
    travelRadiusMeters: number;
  } | null;
  // The real, actually-written home location — onboarding posts here (POST /users/me/profile),
  // and match.ts/explore.ts already read from here for recommendations and discovery. Real bug
  // found via a fresh pilot test (not assumed): this page used to read `locationPrefs` instead
  // (a parallel, entirely separate LocationPreference table that onboarding never writes to at
  // all), so a user who'd set "Stafford" during onboarding saw "Not set" here — the location
  // was never lost, the page was just reading from a table nothing populates. See
  // docs/DECISIONS.md#location-persistence.
  profile: { homeCity: string | null } | null;
  locationPrefs: { kind: string; label: string }[];
}


type DangerAction = 'deactivate' | 'delete' | null;

/**
 * The account surface the app never actually had: everywhere else, "Profile" in the tab bar
 * pointed straight at the taste-onboarding wizard, which has no notion of identity, sign-out,
 * or account lifecycle — a returning user had no way to see their own email, sign out of a
 * shared device, or close their account, even though all three already existed as real backend
 * endpoints (POST /auth/logout, /users/me/deactivate, /users/me/delete). This page is the first
 * thing that actually calls them.
 *
 * Profile V2 — brought onto the same primitives as Home/Crews/Plans (see
 * docs/DECISIONS.md#v2-art-direction); same data/logic, only the presentation changed.
 */
export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dangerAction, setDangerAction] = useState<DangerAction>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ user: ProfileUser }>('/users/me')
      .then((res) => setUser(res.user))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/auth?next=/profile');
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not load your profile.');
      });
  }, [router]);

  async function signOut() {
    setBusy(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // Sign-out should never leave someone stuck on a broken page — even if the request
      // fails, still send them to /auth; the cookie is httpOnly so there's nothing else for
      // the client to clean up locally.
    }
    router.push('/auth');
  }

  async function confirmDanger() {
    if (!dangerAction) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(dangerAction === 'deactivate' ? '/users/me/deactivate' : '/users/me/delete');
      router.push('/auth');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
      setDangerAction(null);
    }
  }

  if (!user) {
    return (
      <div className="v2">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error ? <div style={{ color: 'var(--v2-error)' }}>{error}</div> : <div className="v2-skeleton" style={{ height: 120, borderRadius: 'var(--v2-r-lg)' }} />}
        </div>
      </div>
    );
  }

  const homeCity = user.profile?.homeCity ?? null;
  const favs = user.locationPrefs.filter((p) => p.kind === 'FAVOURITE');
  const liked = user.tasteProfile
    ? Object.entries(user.tasteProfile.categoryAffinity)
        .filter(([, v]) => v > 0.3)
        .map(([k]) => k)
    : [];
  const memberSince = new Date(user.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <div className="v2">
      <div className="v2-shell-desktop">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
            <MediaUploadButton
              uploadPath="/users/me/avatar"
              deletePath="/users/me/avatar"
              size={56}
              presetKind="avatar"
              onChange={(url) => setUser((prev) => (prev ? { ...prev, avatarUrl: url } : prev))}
            >
              <PersonAvatar name={user.displayName} email={user.email} photoUrl={user.avatarUrl} size={56} />
            </MediaUploadButton>
            <div>
              <h1 className="v2-display" style={{ fontSize: 21, marginBottom: 2 }}>{user.displayName || 'Your profile'}</h1>
              <div className="v2-muted" style={{ fontSize: 13 }}>{user.email}</div>
              <div className="v2-dim" style={{ fontSize: 11.5 }}>Member since {memberSince}</div>
            </div>
          </div>

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          <div className="v2-card" style={{ padding: '18px 20px', marginBottom: 14 }}>
            <div className="v2-eyebrow">Areas</div>
            <p style={{ margin: '6px 0 0', fontSize: 14.5 }}>
              {homeCity ?? 'Not set'}
              {favs.length > 0 && ` · also likes ${favs.map((f) => f.label).join(', ')}`}
            </p>

            <div style={{ height: 1, background: 'var(--v2-line)', margin: '16px 0' }} />

            <div className="v2-eyebrow">Into</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {liked.length ? (
                liked.map((c) => (
                  <span key={c} className="v2-chip">
                    {c.replace(/_/g, ' ')}
                  </span>
                ))
              ) : (
                <span className="v2-dim">Nothing marked yet.</span>
              )}
            </div>

            {user.tasteProfile && (
              <>
                <div style={{ height: 1, background: 'var(--v2-line)', margin: '16px 0' }} />
                <div className="v2-eyebrow">Budget &amp; energy</div>
                <p style={{ margin: '6px 0 0', fontSize: 14.5 }}>
                  Up to {formatPriceFrom(user.tasteProfile.budgetMaxMinor)?.replace('from ', '') ?? '—'} · {user.tasteProfile.energyPreference.toLowerCase()} energy
                </p>
              </>
            )}

            <Link href="/onboarding?next=/profile" className="v2-btn v2-btn-brand" style={{ marginTop: 18, width: '100%' }}>
              Edit taste &amp; areas
            </Link>
          </div>

          <div className="v2-card" style={{ padding: '8px 20px', marginBottom: 14 }}>
            <button
              onClick={signOut}
              disabled={busy}
              style={{ width: '100%', padding: '14px 0', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 14.5, fontWeight: 700, color: 'var(--v2-ink)' }}
            >
              Sign out
            </button>
          </div>

          <div className="v2-card" style={{ padding: '18px 20px' }}>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Danger zone</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => setDangerAction('deactivate')}
                disabled={busy}
                style={{ padding: '12px 16px', borderRadius: 100, border: 'none', background: 'var(--v2-bg-deep)', color: 'var(--v2-error)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}
              >
                Deactivate account
              </button>
              <button
                onClick={() => setDangerAction('delete')}
                disabled={busy}
                style={{ padding: '12px 16px', borderRadius: 100, border: 'none', background: 'var(--v2-bg-deep)', color: 'var(--v2-error)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}
              >
                Delete account
              </button>
            </div>
            <p className="v2-dim" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
              Deactivating signs you out everywhere and hides you from your Crews — you can come back later. Deleting
              removes your personal details for good.
            </p>
          </div>
        </div>
      </div>

      <BottomSheet open={dangerAction !== null} onClose={() => !busy && setDangerAction(null)}>
        {dangerAction && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{dangerAction === 'deactivate' ? 'Deactivate account?' : 'Delete account?'}</div>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: '8px 0 16px' }}>
              {dangerAction === 'deactivate'
                ? 'You’ll be signed out on every device and your Crews will stop seeing you as active. You can sign back in any time to reactivate.'
                : 'This permanently removes your name, email and taste profile from Plot. Your Crews and past Plans stay intact for everyone else, but you won’t be identifiable in them any more. This can’t be undone.'}
            </p>
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={confirmDanger} disabled={busy}>
              {busy ? 'Working…' : dangerAction === 'deactivate' ? 'Yes, deactivate' : 'Yes, delete my account'}
            </button>
            <button className="v2-btn v2-btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setDangerAction(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        )}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
