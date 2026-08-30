'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';

interface CrewDetail {
  id: string;
  name: string;
  inviteCode: string;
  members: { user: { id: string; displayName: string | null; email: string } }[];
  dna: { confidence: string; topCategories: string[]; medianSpendMinor: number; bestNights: string[]; usualAreas: string[] } | null;
  plans: { id: string; title: string; status: string; publicSlug: string }[];
}

interface DayAvailability {
  day: string;
  freeCount: number;
  totalMembers: number;
}

const AVATAR_COLORS = ['#f2a93b', '#7fb79a', '#ea5b3d', '#9c97ae', '#6b8ef2'];
function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}
function initials(displayName: string | null, email: string) {
  return (displayName?.trim() || email).slice(0, 1).toUpperCase();
}

export default function CrewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [crew, setCrew] = useState<CrewDetail | null>(null);
  const [availability, setAvailability] = useState<DayAvailability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    api
      .get<{ crew: CrewDetail }>(`/crews/${id}`)
      .then((res) => setCrew(res.crew))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Crew.'));
    api
      .get<{ availability: DayAvailability[] }>(`/crews/${id}/availability?days=0,1,2,3`)
      .then((res) => setAvailability(res.availability))
      .catch(() => {});
  }, [id]);

  function findUsSomething() {
    setFinding(true);
    router.push(`/crews/${id}/match`);
  }

  async function getInviteLink() {
    const res = await api.post<{ inviteUrl: string }>(`/crews/${id}/invites`, { channel: 'link' });
    setInviteUrl(res.inviteUrl);
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: `Join ${crew?.name} on Plot`, url: inviteUrl });
        return;
      }
    } catch {
      // user cancelled the share sheet — fall through to clipboard, nothing to report
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked (permissions, non-HTTPS context) — the link is still visible to copy by hand
    }
  }

  if (!crew) {
    return (
      <div className="page">
        {error ? (
          <div className="error">{error}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 20 }}>
            <div className="card" style={{ height: 90, opacity: 0.5 }} />
            <div className="card" style={{ height: 64, opacity: 0.5 }} />
          </div>
        )}
      </div>
    );
  }

  const solo = crew.members.length === 1;

  return (
    <>
      <nav className="nav">
        <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
          ← Crews
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <h1 style={{ fontSize: 26, marginBottom: 4 }}>{crew.name}</h1>
            <p className="muted" style={{ marginBottom: 0 }}>
              {crew.members.length} {crew.members.length === 1 ? 'person' : 'people'}
            </p>
          </div>
          <div className="stack">
            {crew.members.slice(0, 5).map((m) => (
              <div key={m.user.id} className="avatar" style={{ background: avatarColor(m.user.displayName ?? m.user.email) }}>
                {initials(m.user.displayName, m.user.email)}
              </div>
            ))}
          </div>
        </div>

        {solo && (
          <div className="banner-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 26, marginBottom: 6 }}>🎉</div>
            <p style={{ marginBottom: 4 }}>It&rsquo;s just you here so far.</p>
            <p className="muted" style={{ marginBottom: 12 }}>Invite your friends to start planning together.</p>
            {inviteUrl ? (
              <button className="btn btn-primary" onClick={copyInvite}>
                {copied ? '✓ Copied' : 'Share invite link'}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={getInviteLink}>
                Get invite link
              </button>
            )}
          </div>
        )}

        {crew.dna && !solo && (
          <div className="banner-card">
            <div className="eyebrow">Group DNA · {crew.dna.confidence.toLowerCase()} confidence</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 12px' }}>
              {crew.dna.topCategories.length ? (
                crew.dna.topCategories.map((c) => (
                  <span key={c} className="chip gold static">
                    {c}
                  </span>
                ))
              ) : (
                <span className="muted">Plot is still learning this Crew&rsquo;s taste.</span>
              )}
            </div>
            {crew.dna.medianSpendMinor > 0 && <div className="muted">Median spend £{(crew.dna.medianSpendMinor / 100).toFixed(0)}</div>}
          </div>
        )}

        {availability.length > 0 && !solo && (
          <div className="card">
            <div className="eyebrow">Everyone&rsquo;s evening</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {availability.map((d) => (
                <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                  <div className="muted" style={{ fontSize: 10 }}>
                    {d.day}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      padding: '8px 0',
                      borderRadius: 8,
                      fontSize: 11,
                      background: d.freeCount / d.totalMembers >= 0.6 ? 'var(--ink-moss)' : 'var(--ink-surface-2)',
                      color: d.freeCount / d.totalMembers >= 0.6 ? '#0c1712' : 'var(--ink-text-muted)',
                      fontWeight: 700,
                    }}
                  >
                    {d.freeCount}/{d.totalMembers}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
          <button className="btn btn-primary" onClick={findUsSomething} disabled={finding} style={{ flex: 1 }}>
            {finding ? 'Thinking…' : '✨ Find us something'}
          </button>
          <Link href={`/crews/${id}/chat`} className="btn" style={{ flex: '0 0 auto', textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            💬 Chat
          </Link>
        </div>

        {crew.plans.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 20 }}>
              Plans
            </div>
            {crew.plans.map((plan) => (
              <Link key={plan.id} href={`/plans/${plan.publicSlug}`} className="card" style={{ display: 'block', textDecoration: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{plan.title}</span>
                  <span className="chip static" style={{ fontSize: 10 }}>
                    {plan.status}
                  </span>
                </div>
              </Link>
            ))}
          </>
        )}

        {!solo && (
          <>
            <div className="eyebrow" style={{ marginTop: 20 }}>
              Invite
            </div>
            {inviteUrl ? (
              <button className="card" onClick={copyInvite} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <span className="muted" style={{ wordBreak: 'break-all' }}>{inviteUrl}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-gold)', flexShrink: 0 }}>{copied ? '✓ Copied' : 'Copy'}</span>
              </button>
            ) : (
              <button className="btn" onClick={getInviteLink}>
                Get invite link
              </button>
            )}
          </>
        )}

        {error && <div className="error">{error}</div>}
      </div>
      <TabBar />
    </>
  );
}
