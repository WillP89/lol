'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

function AuthForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? undefined;

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ devMagicLinkUrl?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resent, setResent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // `next` (e.g. /crews/join/abc123 from an invite link) rides along in the magic-link
      // email/dev-link itself so signing in lands you back where you meant to go.
      const result = await api.post<{ ok: true; devMagicLinkUrl?: string }>('/auth/magic-link', { email, next });
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
      const result = await api.post<{ ok: true; devMagicLinkUrl?: string }>('/auth/magic-link', { email, next });
      setSent(result);
      setResent(true);
      setTimeout(() => setResent(false), 2500);
    } catch {
      // the original "check your email" state is still accurate — quietly retry-able
    }
  }

  return (
    <div className="v2" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div className="v2-page" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <div style={{ width: 44, height: 44, borderRadius: 14, background: 'var(--v2-plum)', color: 'var(--v2-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 28, fontFamily: 'Bricolage Grotesque, sans-serif', fontWeight: 800, fontSize: 19 }}>
          P
        </div>

        {!sent ? (
          <div className="fade-up">
            <h1 className="v2-display" style={{ fontSize: 27, marginBottom: 8 }}>What&rsquo;s your email?</h1>
            <p className="v2-muted" style={{ marginBottom: 24 }}>No password — we&rsquo;ll send a link that signs you straight in.</p>
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
              <button className="v2-btn v2-btn-brand" disabled={loading || !email} type="submit" style={{ padding: '16px 22px', fontSize: 15.5 }}>
                {loading ? 'Sending…' : 'Send my link'}
              </button>
              {error && <div style={{ color: 'var(--v2-brand)', fontSize: 13 }}>{error}</div>}
            </form>
          </div>
        ) : (
          <div className="v2-card fade-up" style={{ textAlign: 'center', padding: '32px 26px' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(28,122,82,0.12)', color: 'var(--v2-green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 22 }}>
              ✓
            </div>
            <p className="v2-display" style={{ fontSize: 18, marginBottom: 8 }}>Check your email</p>
            <p className="v2-muted" style={{ fontSize: 13.5, marginBottom: sent.devMagicLinkUrl ? 18 : 6 }}>
              We sent a sign-in link to <strong>{email}</strong>. It expires in 15 minutes.
            </p>
            {sent.devMagicLinkUrl ? (
              <>
                <p className="v2-dim" style={{ fontSize: 12, marginBottom: 12 }}>No email provider is configured yet — here&rsquo;s the link directly:</p>
                <a className="v2-btn v2-btn-brand" href={sent.devMagicLinkUrl} style={{ marginBottom: 12 }}>
                  Continue →
                </a>
              </>
            ) : null}
            <button onClick={resend} className="v2-btn v2-btn-ghost" style={{ fontSize: 13 }}>
              {resent ? '✓ Sent again' : "Didn't get it? Resend"}
            </button>
          </div>
        )}

        <p className="v2-dim" style={{ fontSize: 12, marginTop: 22, textAlign: 'center' }}>
          <Link href="/" className="v2-dim">← Back</Link>
        </p>
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="v2" style={{ minHeight: '100vh' }} />}>
      <AuthForm />
    </Suspense>
  );
}
