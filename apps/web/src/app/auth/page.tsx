'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

type LoginResponse =
  | { mode: 'logged_in'; user: { id: string; email: string; displayName: string | null } }
  | { mode: 'link_sent'; devMagicLinkUrl?: string };

function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? undefined;

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
    <div className="v2" style={{ minHeight: '100dvh', position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
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
 * THE SIGN-IN PAGE'S OWN ATMOSPHERE — real, reported feedback: the one screen every single
 * person has to sit on before they can do anything else was flat and static — a plain card on a
 * blank ground — while the rest of the product (Home's hero, the Crew art system, the landing
 * page's own drifting collage) all carry real colour and motion. This gives the entrance the same
 * life without touching the form itself: soft, slowly drifting colour fields plus a faint echo of
 * the landing page's own tilted plan-card collage, both blurred and dimmed well behind the card so
 * they read as atmosphere, never compete with the one thing that matters here — typing an email
 * and hitting Continue. `aria-hidden` throughout; purely decorative, never focusable. Respects
 * `prefers-reduced-motion` (globals.css guards `.v2-auth-blob`/`.v2-auth-drift-card`'s animations).
 */
function AuthAtmosphere() {
  return (
    <div aria-hidden className="v2-auth-atmosphere">
      <div className="v2-auth-blob" style={{ width: 480, height: 480, top: '-14%', left: '-10%', background: 'var(--v2-pop)', animationDelay: '0s' }} />
      <div className="v2-auth-blob" style={{ width: 420, height: 420, bottom: '-16%', right: '-8%', background: 'var(--v2-confetti-2)', animationDelay: '-7s' }} />
      <div className="v2-auth-blob" style={{ width: 360, height: 360, top: '38%', right: '18%', background: 'var(--v2-confetti-4)', animationDelay: '-14s' }} />

      <div className="v2-auth-drift-card" style={{ width: 108, height: 150, top: '14%', right: '10%', background: `linear-gradient(155deg, var(--v2-confetti-1), rgba(12,12,13,0.85))`, transform: 'rotate(-8deg)' }} />
      <div className="v2-auth-drift-card" style={{ width: 96, height: 132, bottom: '10%', left: '8%', background: `linear-gradient(155deg, var(--v2-confetti-3), rgba(12,12,13,0.85))`, transform: 'rotate(10deg)', animationDelay: '-10s' }} />
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
