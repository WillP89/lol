'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { categoryStyle } from '@/lib/categoryStyle';
import { displayNameOf } from '@/lib/displayName';

interface Plan {
  id: string;
  title: string;
  status: string;
  publicSlug: string;
  votes: { vote: string }[];
  members: unknown[];
  experience: { category: string; startsAt: string; venue: { name: string } | null } | null;
}

interface CrewDetail {
  id: string;
  name: string;
  inviteCode: string;
  members: { user: { id: string; displayName: string | null; email: string } }[];
  dna: { confidence: string; topCategories: string[]; medianSpendMinor: number; bestNights: string[]; usualAreas: string[] } | null;
  plans: Plan[];
  recentMessages: { id: string; body: string; createdAt: string; author: { id: string; displayName: string | null; email: string } }[];
}

interface DayAvailability {
  day: string;
  freeCount: number;
  totalMembers: number;
}

const ACTIVE_DECISION_STATUSES = new Set(['SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY']);
const AVATAR_COLORS = ['#f2a93b', '#7fb79a', '#ea5b3d', '#9c97ae', '#6b8ef2'];
function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}
function initials(displayName: string | null, email: string) {
  return (displayName?.trim() || email).slice(0, 1).toUpperCase();
}
function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
  // The plans array is already newest-first — the first match in each bucket is "the current
  // one" for that bucket, exactly what a member walking in needs to see without reading chat
  // history to reconstruct it. See docs/DECISIONS.md#home-surface.
  const activePlan = crew.plans.find((p) => ACTIVE_DECISION_STATUSES.has(p.status));
  const upcomingPlan = crew.plans.find((p) => p.status === 'BOOKED');

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

        {/* Upcoming beats everything — a locked-in plan is the most important thing this
            Crew has going on. */}
        {upcomingPlan && (
          <Link
            href={`/plans/${upcomingPlan.publicSlug}`}
            className="banner-card fade-up"
            style={{ display: 'block', textDecoration: 'none', color: 'inherit', border: '1px solid var(--ink-moss)' }}
          >
            <div className="eyebrow" style={{ color: 'var(--ink-moss)' }}>📅 Coming up</div>
            <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 17, margin: '4px 0 2px' }}>{upcomingPlan.title}</div>
            {upcomingPlan.experience && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                {upcomingPlan.experience.venue?.name && `${upcomingPlan.experience.venue.name} · `}
                {new Date(upcomingPlan.experience.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              </div>
            )}
          </Link>
        )}

        {/* An open decision is the second most important thing — this is "what are we
            actually deciding right now", surfaced without reading chat. */}
        {activePlan && (
          <Link
            href={`/plans/${activePlan.publicSlug}`}
            className="card fade-up"
            style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit' }}
          >
            <div className="art-block" style={{ width: 48, height: 48, borderRadius: 12, flexShrink: 0, fontSize: 20, background: categoryStyle(activePlan.experience?.category).bg }}>
              {categoryStyle(activePlan.experience?.category).emoji}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="eyebrow" style={{ marginBottom: 2 }}>🗳️ Deciding</div>
              <div style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePlan.title}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {activePlan.votes.filter((v) => v.vote === 'IN').length}/{activePlan.members.length} in so far
              </div>
            </div>
            <span style={{ color: 'var(--ink-gold)', fontWeight: 700, fontSize: 13 }}>Vote →</span>
          </Link>
        )}

        {/* A conversation preview — the point is "what's the chat about right now", not a
            full transcript; tapping goes to the real thing. */}
        {crew.recentMessages.length > 0 && !solo && (
          <Link href={`/crews/${id}/chat`} className="card fade-up" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className="eyebrow" style={{ marginBottom: 0 }}>💬 Conversation</div>
              <span className="muted" style={{ fontSize: 11 }}>Open chat →</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {crew.recentMessages.map((m) => (
                <div key={m.id} style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 700 }}>{displayNameOf(m.author.displayName, m.author.email)}: </span>
                  <span className="muted">{m.body}</span>
                </div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>{timeAgo(crew.recentMessages[crew.recentMessages.length - 1].createdAt)}</div>
          </Link>
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
