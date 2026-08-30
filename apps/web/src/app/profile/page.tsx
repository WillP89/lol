'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { BottomSheet } from '@/components/BottomSheet';
import { formatPriceFrom } from '@/lib/formatPrice';

interface ProfileUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  tasteProfile: {
    categoryAffinity: Record<string, number>;
    budgetMaxMinor: number;
    energyPreference: 'LOW' | 'MEDIUM' | 'HIGH';
  } | null;
  locationPrefs: { kind: string; label: string }[];
}

function initials(displayName: string | null, email: string) {
  return (displayName?.trim() || email).slice(0, 1).toUpperCase();
}

type DangerAction = 'deactivate' | 'delete' | null;

/**
 * The account surface the app never actually had: everywhere else, "Profile" in the tab bar
 * pointed straight at the taste-onboarding wizard, which has no notion of identity, sign-out,
 * or account lifecycle — a returning user had no way to see their own email, sign out of a
 * shared device, or close their account, even though all three already existed as real backend
 * endpoints (POST /auth/logout, /users/me/deactivate, /users/me/delete). This page is the first
 * thing that actually calls them.
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
      <div className="page" style={{ paddingTop: 40, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error ? <div className="error">{error}</div> : <div className="card" style={{ height: 120, opacity: 0.5 }} />}
      </div>
    );
  }

  const home = user.locationPrefs.find((p) => p.kind === 'HOME');
  const favs = user.locationPrefs.filter((p) => p.kind === 'FAVOURITE');
  const liked = user.tasteProfile
    ? Object.entries(user.tasteProfile.categoryAffinity)
        .filter(([, v]) => v > 0.3)
        .map(([k]) => k)
    : [];
  const memberSince = new Date(user.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <>
      <nav className="nav">
        <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
          ← Crews
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <div className="avatar" style={{ width: 56, height: 56, fontSize: 22, background: 'var(--ink-gold)', color: 'var(--ink-gold-ink)' }}>
            {initials(user.displayName, user.email)}
          </div>
          <div>
            <h1 style={{ fontSize: 21, marginBottom: 2 }}>{user.displayName || 'Your profile'}</h1>
            <div className="muted" style={{ fontSize: 13 }}>{user.email}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>Member since {memberSince}</div>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="banner-card">
          <div className="eyebrow">Areas</div>
          <p style={{ margin: '6px 0 0' }}>
            {home?.label ?? 'Not set'}
            {favs.length > 0 && ` · also likes ${favs.map((f) => f.label).join(', ')}`}
          </p>

          <div style={{ height: 1, background: 'var(--ink-border)', margin: '14px 0' }} />

          <div className="eyebrow">Into</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {liked.length ? (
              liked.map((c) => (
                <span key={c} className="chip gold static">
                  {c.replace(/_/g, ' ')}
                </span>
              ))
            ) : (
              <span className="muted">Nothing marked yet.</span>
            )}
          </div>

          {user.tasteProfile && (
            <>
              <div style={{ height: 1, background: 'var(--ink-border)', margin: '14px 0' }} />
              <div className="eyebrow">Budget &amp; energy</div>
              <p style={{ margin: '6px 0 0' }}>
                Up to {formatPriceFrom(user.tasteProfile.budgetMaxMinor)?.replace('from ', '') ?? '—'} · {user.tasteProfile.energyPreference.toLowerCase()} energy
              </p>
            </>
          )}

          <Link href="/onboarding?next=/profile" className="btn" style={{ marginTop: 16 }}>
            Edit taste &amp; areas
          </Link>
        </div>

        <div className="card">
          <button className="btn btn-ghost" onClick={signOut} disabled={busy} style={{ justifyContent: 'flex-start' }}>
            🚪 Sign out
          </button>
        </div>

        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 10 }}>Danger zone</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-danger" onClick={() => setDangerAction('deactivate')} disabled={busy}>
              Deactivate account
            </button>
            <button className="btn btn-danger" onClick={() => setDangerAction('delete')} disabled={busy}>
              Delete account
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 10, marginBottom: 0 }}>
            Deactivating signs you out everywhere and hides you from your Crews — you can come back later. Deleting
            removes your personal details for good.
          </p>
        </div>
      </div>

      <BottomSheet open={dangerAction !== null} onClose={() => !busy && setDangerAction(null)}>
        {dangerAction && (
          <div>
            <div className="eyebrow">{dangerAction === 'deactivate' ? 'Deactivate account?' : 'Delete account?'}</div>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: '8px 0 16px' }}>
              {dangerAction === 'deactivate'
                ? 'You’ll be signed out on every device and your Crews will stop seeing you as active. You can sign back in any time to reactivate.'
                : 'This permanently removes your name, email and taste profile from Plot. Your Crews and past Plans stay intact for everyone else, but you won’t be identifiable in them any more. This can’t be undone.'}
            </p>
            <button className="btn btn-danger" onClick={confirmDanger} disabled={busy}>
              {busy ? 'Working…' : dangerAction === 'deactivate' ? 'Yes, deactivate' : 'Yes, delete my account'}
            </button>
            <button className="btn btn-ghost" onClick={() => setDangerAction(null)} disabled={busy} style={{ marginTop: 8 }}>
              Cancel
            </button>
          </div>
        )}
      </BottomSheet>

      <TabBar />
    </>
  );
}
