'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

// The magic-link token is single-use — this page's effect can genuinely run more than once for
// the exact same token: React 18 dev-mode StrictMode double-invokes effects, AND clicking a
// plain `<a>` into this route from elsewhere in the app (e.g. the "sent" state on /auth) is a
// Next.js App Router client-side transition that mounts a fresh component instance, so a
// component-scoped guard (useRef/useState) doesn't survive it — a *second*, genuinely new
// instance still fires its own first call. Only something that survives across mounts within
// the same page load works: a module-level record of tokens already requested. The first call
// consumes the token; without this, any repeat call legitimately 401s ("already used") and the
// whole sign-in stalls here. See docs/DECISIONS.md#auth-callback-dedup.
const requestedTokens = new Set<string>();

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      if (requestedTokens.has(token)) return;
      requestedTokens.add(token);
    }
    const next = params.get('next');
    if (!token) {
      setError('Missing token.');
      return;
    }
    // Same real bug/fix as /auth's own submit (see that page's comment): no timeout here meant a
    // cold Render backend on the first request of the day left this page reading "Signing you
    // in…" forever, with no way out short of a manual refresh. A bounded timeout turns a
    // genuinely stuck request into the same honest, retry-able error state a real failure
    // already gets — a slow-but-working cold start still succeeds well inside 40s.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 40_000);
    api
      .post('/auth/callback', { token }, { signal: controller.signal })
      .then(async () => {
        const destination = next || '/home';
        // A brand-new user (no profile yet) always completes onboarding first — including
        // when they arrived via an invite link. Onboarding itself carries `next` through
        // (?next=/crews/join/abc123) so finishing it lands them exactly back on the invite,
        // not on the generic Home feed. A returning user with a profile already skips
        // straight to `destination` — the invite, or Home by default.
        try {
          const { user } = await api.get<{
            user: { tasteProfile: unknown; profile: { homeLat: number | null } | null };
          }>('/users/me');
          // `tasteProfile` alone isn't proof this person has been through *this* onboarding —
          // confirmed live: an account with a taste row saved from testing earlier this session
          // (before today's location step existed) skipped straight past the interests screen
          // entirely on a later sign-in. `homeLat` is only ever set by the current
          // LocationSearch step, so it's a real signal this exact flow was completed, not just
          // that some taste data exists from however long ago.
          const onboarded = Boolean(user.tasteProfile) && user.profile?.homeLat != null;
          router.replace(onboarded ? destination : `/onboarding?next=${encodeURIComponent(destination)}`);
        } catch {
          router.replace(`/onboarding?next=${encodeURIComponent(destination)}`);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setError("That's taking longer than it should — check your connection and try again.");
        } else {
          setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
        }
      })
      .finally(() => clearTimeout(abortTimer));
  }, [params, router]);

  return (
    <>
      {error ? (
        <>
          <div style={{ color: 'var(--v2-error)', fontSize: 13.5 }}>{error}</div>
          <a className="v2-btn v2-btn-brand" href="/auth" style={{ marginTop: 16 }}>
            Try again
          </a>
        </>
      ) : (
        <p className="v2-muted">Signing you in…</p>
      )}
    </>
  );
}

export default function AuthCallbackPage() {
  return (
    <div className="v2">
      <div className="v2-page" style={{ paddingTop: 80, textAlign: 'center' }}>
        <Suspense fallback={<p className="v2-muted">Signing you in…</p>}>
          <CallbackInner />
        </Suspense>
      </div>
    </div>
  );
}
