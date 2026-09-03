'use client';

import { Suspense, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { usePointerParallax } from '@/lib/usePointerParallax';
import { ParticleField } from '@/components/ParticleField';

type LoginResponse =
  | { mode: 'logged_in'; user: { id: string; email: string; displayName: string | null } }
  | { mode: 'link_sent'; devMagicLinkUrl?: string };

function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? undefined;

  // Same shared parallax root as the landing page's own hero (lib/usePointerParallax.ts) — the
  // atmosphere behind the card genuinely responds to the cursor here too, not just drifting on a
  // timer. See AuthAtmosphere below for how each layer reads it.
  const rootRef = useRef<HTMLDivElement>(null);
  usePointerParallax(rootRef);

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ devMagicLinkUrl?: string } | null>(null);
  // A returning, already-verified email (see apps/api/src/services/auth.ts#loginOrRequestLink)
  // skips the link entirely — this is the brief "you're in" beat shown while the redirect fires,
  // so instant login reads as a considered moment rather than a jarring blank-page flash.
  const [welcomingBack, setWelcomingBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resent, setResent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // `next` (e.g. /crews/join/abc123 from an invite link) rides along so signing in lands
      // you back where you meant to go — same for the instant-login path below and the emailed
      // link's own callback.
      const result = await api.post<LoginResponse>('/auth/login', { email, next });
      if (result.mode === 'logged_in') {
        setWelcomingBack(true);
        setTimeout(() => router.push(next && next.startsWith('/') ? next : '/home'), 650);
        return;
      }
      setSent(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that — check the address and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setResent(false);
    try {
      const result = await api.post<LoginResponse>('/auth/login', { email, next });
      if (result.mode === 'logged_in') {
        setWelcomingBack(true);
        setTimeout(() => router.push(next && next.startsWith('/') ? next : '/home'), 650);
        return;
      }
      setSent(result);
      setResent(true);
      setTimeout(() => setResent(false), 2500);
    } catch {
      // the original "check your email" state is still accurate — quietly retry-able
    }
  }

  return (
    <div ref={rootRef} className="v2" style={{ minHeight: '100dvh', position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
      <AuthAtmosphere />

      <div className="v2-page" style={{ position: 'relative', zIndex: 1, paddingTop: 0, paddingBottom: 0 }}>
        <Link href="/" className="v2-tap-feedback" style={{ display: 'inline-block', fontFamily: 'Archivo, sans-serif', fontWeight: 900, fontSize: 22, letterSpacing: '-0.02em', marginBottom: 32 }}>
          Plot
        </Link>

        {welcomingBack ? (
          <div className="v2-card v2-auth-welcome-in" style={{ textAlign: 'center', padding: '36px 26px' }}>
            <span className="v2-plotfound-mark" style={{ color: 'var(--v2-pop)', display: 'inline-flex', marginBottom: 14 }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4" r="2" fill="currentColor" /><circle cx="4" cy="18" r="2" fill="currentColor" /><circle cx="20" cy="18" r="2" fill="currentColor" /><path d="M12 6v6l-6 4M12 12l6 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </span>
            <p className="v2-display" style={{ fontSize: 19 }}>Welcome back.</p>
          </div>
        ) : !sent ? (
          <div className="fade-up">
            <h1 className="v2-display" style={{ fontSize: 27, marginBottom: 8 }}>What&rsquo;s your email?</h1>
            <p className="v2-muted" style={{ marginBottom: 24 }}>
              Already on Plot? You&rsquo;ll go straight in. New here? We&rsquo;ll send a link that signs you up.
            </p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                style={{ width: '100%', padding: '15px 18px', borderRadius: 16, border: 'none', outline: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', fontSize: 15.5, fontFamily: 'inherit', color: 'var(--v2-ink)' }}
                type="email"
                required
                autoFocus
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="v2-btn v2-btn-brand v2-tap-feedback" disabled={loading || !email} type="submit" style={{ padding: '16px 22px', fontSize: 15.5 }}>
                {loading ? 'Checking…' : 'Continue'}
              </button>
              {error && <div style={{ color: 'var(--v2-error)', fontSize: 13 }}>{error}</div>}
            </form>
          </div>
        ) : (
          <div className="v2-card fade-up" style={{ textAlign: 'center', padding: '32px 26px' }}>
            <div className="v2-pop-in" style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(27,122,77,0.12)', color: 'var(--v2-green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 22 }}>
              ✓
            </div>
            <p className="v2-display" style={{ fontSize: 18, marginBottom: 8 }}>Check your email</p>
            <p className="v2-muted" style={{ fontSize: 13.5, marginBottom: sent.devMagicLinkUrl ? 18 : 6 }}>
              We sent a sign-in link to <strong>{email}</strong>. It expires in 15 minutes.
            </p>
            {sent.devMagicLinkUrl ? (
              <>
                <p className="v2-dim" style={{ fontSize: 12, marginBottom: 12 }}>No email provider is configured yet — here&rsquo;s the link directly:</p>
                <a className="v2-btn v2-btn-brand v2-tap-feedback" href={sent.devMagicLinkUrl} style={{ marginBottom: 12 }}>
                  Continue →
                </a>
              </>
            ) : null}
            <button onClick={resend} className="v2-btn v2-btn-ghost v2-tap-feedback" style={{ fontSize: 13 }}>
              {resent ? '✓ Sent again' : "Didn't get it? Resend"}
            </button>
          </div>
        )}

        {!welcomingBack && (
          <p className="v2-dim" style={{ fontSize: 12, marginTop: 22, textAlign: 'center' }}>
            <Link href="/" className="v2-dim">← Back</Link>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * THE SIGN-IN PAGE'S OWN ATMOSPHERE — second real round of reported feedback ("still no movement
 * at all... more immersive", citing a reference site built on a drifting particle field and real
 * parallax depth) — the first pass (slow blurred blobs on a timer) wasn't enough. Same primitives
 * as the landing page's own hero atmosphere (LandingClient.tsx — a live particle field, a
 * breathing "core" glow, and every layer reading the shared `--px`/`--py` pointer-parallax
 * variables with its own depth multiplier, set on the page's own root ref above) so the two
 * entrance screens genuinely match rather than one feeling like an afterthought. Still never
 * competes with the one thing that matters here — typing an email and hitting Continue: every
 * layer sits well behind the card in opacity/blur/z-index, `aria-hidden` throughout. Each blob is
 * two nested nodes (outer owns position + parallax `translate3d`, inner `.v2-auth-blob` owns its
 * size/colour + its own independent idle-drift animation) since a running CSS animation replaces
 * the whole `transform` property and would otherwise clobber the parallax offset. Respects
 * `prefers-reduced-motion` throughout (ParticleField freezes to one still frame; the drift/breathe
 * animations turn off; the parallax layer is simply never wired up at all — see
 * usePointerParallax's own comment).
 */
function AuthAtmosphere() {
  return (
    <div aria-hidden className="v2-auth-atmosphere">
      <ParticleField count={34} />
      <div className="v2-hero-core" style={{ top: '38%', left: '50%', width: 460, height: 460, margin: '-230px 0 0 -230px', opacity: 0.16, transform: 'translate3d(calc(var(--px, 0) * 7px), calc(var(--py, 0) * 7px), 0)' }} />

      <div style={{ position: 'absolute', width: 480, height: 480, top: '-14%', left: '-10%', transform: 'translate3d(calc(var(--px, 0) * -16px), calc(var(--py, 0) * -12px), 0)' }}>
        <div className="v2-auth-blob" style={{ position: 'absolute', inset: 0, background: 'var(--v2-pop)', animationDelay: '0s' }} />
      </div>
      <div style={{ position: 'absolute', width: 420, height: 420, bottom: '-16%', right: '-8%', transform: 'translate3d(calc(var(--px, 0) * 18px), calc(var(--py, 0) * 14px), 0)' }}>
        <div className="v2-auth-blob" style={{ position: 'absolute', inset: 0, background: 'var(--v2-confetti-2)', animationDelay: '-7s' }} />
      </div>
      <div style={{ position: 'absolute', width: 360, height: 360, top: '38%', right: '18%', transform: 'translate3d(calc(var(--px, 0) * -12px), calc(var(--py, 0) * 10px), 0)' }}>
        <div className="v2-auth-blob" style={{ position: 'absolute', inset: 0, background: 'var(--v2-confetti-4)', animationDelay: '-14s' }} />
      </div>

      <div style={{ position: 'absolute', width: 108, height: 150, top: '14%', right: '10%', transform: 'translate3d(calc(var(--px, 0) * 26px), calc(var(--py, 0) * 20px), 0)' }}>
        <div className="v2-auth-drift-card" style={{ position: 'absolute', inset: 0, background: `linear-gradient(155deg, var(--v2-confetti-1), rgba(12,12,13,0.85))`, ['--tilt' as string]: '-8deg' }} />
      </div>
      <div style={{ position: 'absolute', width: 96, height: 132, bottom: '10%', left: '8%', transform: 'translate3d(calc(var(--px, 0) * -24px), calc(var(--py, 0) * -18px), 0)' }}>
        <div className="v2-auth-drift-card" style={{ position: 'absolute', inset: 0, background: `linear-gradient(155deg, var(--v2-confetti-3), rgba(12,12,13,0.85))`, ['--tilt' as string]: '10deg', animationDelay: '-10s' }} />
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="v2" style={{ minHeight: '100dvh' }} />}>
      <AuthForm />
    </Suspense>
  );
}
