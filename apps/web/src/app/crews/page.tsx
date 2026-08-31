'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { BottomSheet } from '@/components/BottomSheet';
import { messagePreview } from '@/lib/messagePreview';

interface CrewSummary {
  id: string;
  name: string;
  members: { user: { displayName: string | null; email: string } }[];
  latestMessage: { body: string; authorName: string; createdAt: string } | null;
  activePlan: { id: string; title: string; publicSlug: string; inCount: number; totalMembers: number } | null;
  upcomingPlan: { id: string; title: string; publicSlug: string; startsAt: string | null; venueName: string | null } | null;
}

// Same palette as Home V2's avatar/ring colours — one shared identity system across the app,
// not a different set of colours per screen for the same people and Crews.
const AVATAR_COLORS = ['#ff3d5a', '#ffb238', '#1c7a52', '#5b3df0', '#ff6fae'];

function initials(displayName: string | null, email: string) {
  const source = displayName?.trim() || email;
  return source.slice(0, 1).toUpperCase();
}

function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * What a Crew card actually shows, in priority order — this is what turns "a list of Crew
 * names" into "what's actually going on", per docs/DECISIONS.md#home-surface: a locked-in
 * plan beats an open decision beats a chat snippet beats nothing.
 */
function CrewActivityLine({ crew }: { crew: CrewSummary }) {
  if (crew.upcomingPlan) {
    const when = crew.upcomingPlan.startsAt
      ? new Date(crew.upcomingPlan.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      : null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--v2-green)', fontWeight: 700 }}>
        <span>📅</span>
        <span>
          {crew.upcomingPlan.title}
          {when && ` · ${when}`}
        </span>
      </div>
    );
  }
  if (crew.activePlan) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#a06a00', fontWeight: 700 }}>
        <span>🗳️</span>
        <span>
          Deciding: {crew.activePlan.title} · {crew.activePlan.inCount}/{crew.activePlan.totalMembers} in
        </span>
      </div>
    );
  }
  if (crew.latestMessage) {
    return (
      <div className="v2-muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 700, color: 'var(--v2-ink)' }}>{crew.latestMessage.authorName}: </span>
        {messagePreview(crew.latestMessage.body)}
      </div>
    );
  }
  return <div className="v2-dim" style={{ fontSize: 12.5 }}>Someone has to start it — say hi.</div>;
}

type CreateStep = 'name' | 'invite';

/**
 * Crews V2 — the list screen brought in line with the rest of the app (see
 * docs/DECISIONS.md#v2-art-direction): same warm light ground, same card/eyebrow/button
 * vocabulary as Home, same TabBarV2. Same data/logic as before, only the presentation changed.
 */
export default function CrewsPage() {
  const router = useRouter();
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Creation is a short, social two-step flow — never a bare "name field + submit" on the main
  // screen (brief: "creation should feel social, not administrative"). Step 1 names the Crew;
  // step 2 hands you the invite link immediately, because a Crew with nobody in it isn't done.
  const [showCreate, setShowCreate] = useState(false);
  const [step, setStep] = useState<CreateStep>('name');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newCrewId, setNewCrewId] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setShowCreate(true);
  }, []);

  function load() {
    api
      .get<{ crews: CrewSummary[] }>('/crews')
      .then((res) => setCrews(res.crews))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your Crews.'));
  }

  useEffect(load, []);

  function openCreate() {
    setStep('name');
    setName('');
    setNewCrewId(null);
    setInviteUrl(null);
    setShowCreate(true);
  }

  async function createCrew(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      // No hardcoded city — a Crew without its own defaultCity falls back to whoever asks
      // Find Us Something's own home city at request time (see services/match.ts), not a
      // baked-in London assumption from whoever happened to create the Crew.
      const res = await api.post<{ crew: { id: string } }>('/crews', { name: name.trim() });
      setNewCrewId(res.crew.id);
      const invite = await api.post<{ inviteUrl: string }>(`/crews/${res.crew.id}/invites`, { channel: 'link' });
      setInviteUrl(invite.inviteUrl);
      setStep('invite');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create Crew.');
    } finally {
      setCreating(false);
    }
  }

  async function shareInvite() {
    if (!inviteUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: `Join ${name} on Plot`, url: inviteUrl });
        return;
      }
    } catch {
      // user cancelled the share sheet — fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked — the link is still visible to copy by hand
    }
  }

  function finishCreate() {
    setShowCreate(false);
    if (newCrewId) router.push(`/crews/${newCrewId}`);
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '13px 16px',
    borderRadius: 14,
    border: 'none',
    outline: 'none',
    background: 'var(--v2-bg-deep)',
    fontSize: 14.5,
    fontFamily: 'inherit',
    color: 'var(--v2-ink)',
    marginBottom: 10,
  };

  return (
    <div className="v2">
      <div className="v2-shell-desktop">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 26 }}>
            <div>
              <h1 className="v2-display" style={{ fontSize: 30, lineHeight: 1.06, marginBottom: 4 }}>Crews</h1>
              <p className="v2-muted" style={{ fontSize: 14.5 }}>Where your groups live.</p>
            </div>
            <button
              onClick={openCreate}
              aria-label="New Crew"
              className="v2-btn v2-btn-brand"
              style={{ width: 44, height: 44, padding: 0, fontSize: 22, lineHeight: 1, flexShrink: 0 }}
            >
              +
            </button>
          </div>

          {error && <div style={{ color: 'var(--v2-brand)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          {crews === null && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2].map((i) => (
                <div key={i} style={{ height: 78, borderRadius: 'var(--v2-r-lg)', background: 'var(--v2-bg-deep)' }} />
              ))}
            </div>
          )}

          {crews && crews.length > 0 && (
            <div className="v2-card-grid" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {crews.map((crew, i) => (
                <Link
                  key={crew.id}
                  href={`/crews/${crew.id}`}
                  className="v2-card fade-up v2-stagger"
                  style={{ display: 'block', padding: '15px 18px', ['--stagger-i' as string]: i }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <div className="v2-display" style={{ fontSize: 16.5 }}>{crew.name}</div>
                    <div className="stack" style={{ flexShrink: 0 }}>
                      {crew.members.slice(0, 4).map((m, i) => (
                        <div
                          key={i}
                          style={{
                            width: 24, height: 24, borderRadius: '50%', marginLeft: i === 0 ? 0 : -8, fontSize: 9.5, fontWeight: 800, color: '#fff',
                            background: avatarColor(m.user.displayName ?? m.user.email), display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: '2px solid var(--v2-surface)',
                          }}
                        >
                          {initials(m.user.displayName, m.user.email)}
                        </div>
                      ))}
                    </div>
                  </div>
                  <CrewActivityLine crew={crew} />
                  {crew.latestMessage && (crew.upcomingPlan || crew.activePlan) && (
                    <div className="v2-dim" style={{ fontSize: 10.5, marginTop: 4 }}>{timeAgo(crew.latestMessage.createdAt)} ago in chat</div>
                  )}
                </Link>
              ))}
            </div>
          )}

          {crews?.length === 0 && (
            <div style={{ textAlign: 'center', padding: '56px 12px 32px' }}>
              <div style={{ fontSize: 34, marginBottom: 10 }}>👋</div>
              <h2 className="v2-display" style={{ fontSize: 26, marginBottom: 10, lineHeight: 1.15 }}>No Crews yet.</h2>
              <p className="v2-muted" style={{ marginBottom: 22, lineHeight: 1.6, maxWidth: 280, marginInline: 'auto' }}>
                Start one, or ask a friend for their invite link.
              </p>
              <button className="v2-btn v2-btn-brand" onClick={openCreate}>Start a Crew</button>
            </div>
          )}
        </div>
      </div>

      <BottomSheet open={showCreate} onClose={() => !creating && setShowCreate(false)} variant="light">
        {step === 'name' ? (
          <form onSubmit={createCrew}>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>New Crew</div>
            <h2 className="v2-display" style={{ fontSize: 20, marginBottom: 14 }}>What&rsquo;s the Crew called?</h2>
            <input
              style={inputStyle}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. The Boys, Flat 4B"
              required
              maxLength={60}
            />
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} disabled={creating || !name.trim()} type="submit">
              {creating ? 'Creating…' : 'Continue'}
            </button>
          </form>
        ) : (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>You&rsquo;re ready</div>
            <h2 className="v2-display" style={{ fontSize: 20, marginBottom: 6 }}>Invite your people</h2>
            <p className="v2-muted" style={{ marginBottom: 12, fontSize: 13.5 }}>{name} is live. Share the link to get everyone in.</p>
            {inviteUrl && (
              <div style={{ background: 'var(--v2-bg-deep)', borderRadius: 14, padding: 12, marginBottom: 12 }}>
                <span className="v2-muted" style={{ wordBreak: 'break-all', fontSize: 12.5 }}>{inviteUrl}</span>
              </div>
            )}
            <button className="v2-btn v2-btn-brand" style={{ width: '100%', marginBottom: 8 }} onClick={shareInvite} disabled={!inviteUrl}>
              {copied ? '✓ Copied' : 'Share invite link'}
            </button>
            <button className="v2-btn v2-btn-ghost" style={{ width: '100%' }} onClick={finishCreate}>
              Done
            </button>
          </div>
        )}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
