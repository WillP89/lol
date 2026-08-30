'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function AuthForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? undefined;

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ devMagicLinkUrl?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // `next` (e.g. /crews/join/abc123 from an invite link) rides along in the magic-link
      // email/dev-link itself — the API embeds it in the callback URL so signing in lands you
      // back where you actually meant to go, instead of always dumping you on /onboarding.
      const result = await api.post<{ ok: true; devMagicLinkUrl?: string }>('/auth/magic-link', { email, next });
      setSent(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: 60 }}>
      <div className="eyebrow">Sign in</div>
      <h1 style={{ fontSize: 26, marginBottom: 8 }}>What&rsquo;s your email?</h1>
      <p className="muted" style={{ marginBottom: 22 }}>
        No password. We&rsquo;ll send a link that signs you straight in.
      </p>

      {!sent ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            className="field"
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn btn-primary" disabled={loading} type="submit">
            {loading ? 'Sending…' : 'Send my link'}
          </button>
          {error && <div className="error">{error}</div>}
        </form>
      ) : (
        <div className="card">
          <p style={{ marginBottom: 12 }}>Check your email for a sign-in link.</p>
          {sent.devMagicLinkUrl && (
            <>
              <p className="muted" style={{ marginBottom: 10 }}>
                Development mode — no email provider is configured yet (see docs/providers/email.md), so here&rsquo;s the
                link directly:
              </p>
              <a className="btn btn-primary" href={sent.devMagicLinkUrl}>
                Continue →
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="page" style={{ paddingTop: 60 }}><p className="muted">Loading…</p></div>}>
      <AuthForm />
    </Suspense>
  );
}
