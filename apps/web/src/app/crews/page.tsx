'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { BottomSheet } from '@/components/BottomSheet';
import { messagePreview } from '@/lib/messagePreview';
import { PersonAvatar, CrewMark } from '@/components/Avatar';
import { MediaUploadButton } from '@/components/MediaUploadButton';
import { CrewTuneContent } from '@/components/CrewTuneSheet';
import { identityGradient } from '@/lib/identity';
import { isCrewArtUrl } from '@/lib/crewArt';
import { IconMore } from '@/components/icons';

interface CrewSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  members: { user: { displayName: string | null; email: string; avatarUrl?: string | null } }[];
  // Real, persisted unread state — see apps/api/src/services/crew.ts#crewSummaryExtras.
  unreadCount: number;
  latestMessage: { body: string; authorName: string; createdAt: string } | null;
  activePlan: { id: string; title: string; publicSlug: string; inCount: number; totalMembers: number } | null;
  upcomingPlan: { id: string; title: string; publicSlug: string; startsAt: string | null; venueName: string | null } | null;
}

/**
 * What a Crew tile actually shows, in priority order — this is what turns "a Crew's name" into
 * "what's actually going on", per docs/DECISIONS.md#home-surface: a locked-in plan beats an open
 * decision beats a chat snippet beats nothing.
 */
function crewActivityText(crew: CrewSummary): { text: string; tone: 'plan' | 'deciding' | 'chat' | 'quiet' } {
  if (crew.upcomingPlan) {
    const when = crew.upcomingPlan.startsAt
      ? new Date(crew.upcomingPlan.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      : null;
    return { text: `${crew.upcomingPlan.title}${when ? ` · ${when}` : ''}`, tone: 'plan' };
  }
  if (crew.activePlan) {
    return { text: `Deciding: ${crew.activePlan.title} · ${crew.activePlan.inCount}/${crew.activePlan.totalMembers} in`, tone: 'deciding' };
  }
  if (crew.latestMessage) {
    return { text: `${crew.latestMessage.authorName}: ${messagePreview(crew.latestMessage.body)}`, tone: 'chat' };
  }
  return { text: 'Someone has to start it — say hi', tone: 'quiet' };
}

type CreateStep = 'name' | 'look' | 'taste' | 'invite';

/**
 * Crews — HARD RESET (see docs/DECISIONS.md#plot-design-reset-3), not a restyle. The previous
 * version was two columns of identical white rounded rows: a Crew mark, a name, one line of
 * status — read as a database table, not a page of people you actually know. Replaced outright
 * with large identity tiles: real Crew photo/art fills most of the tile, faces and the live
 * activity line sit directly on the image, the way a person actually recognises a group at a
 * glance — not a record they scan.
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
  const [newCrewImageUrl, setNewCrewImageUrl] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // "Before creating a crew, one person must fill out the crew's specific preferences... set it
  // at the crew level by the person who created it... no events or things should be done on
  // crew until preference set" — a mandatory step in the creation flow itself (AI setup or the
  // manual picker, either satisfies it), not something to configure later in settings. The API
  // enforces this for real (see services/crewPreferencesGate.ts + evaluateCrewEligibility's own
  // preferences_not_set gate) — this step is what makes satisfying that gate the obvious next
  // thing to do, not a hidden requirement discovered later when a "Find us something" tap fails.
  const [crewInterestPreferences, setCrewInterestPreferences] = useState<string[]>([]);
  const [tasteSaving, setTasteSaving] = useState(false);
  const [tasteError, setTasteError] = useState<string | null>(null);

  // Real, reported gap: leaving a Crew only existed buried inside that Crew's own chat (avatar
  // cluster -> members sheet -> scroll to the bottom) — nowhere on the list of Crews itself,
  // where you'd actually expect a quick way out. `leaveTarget` holds the one Crew a confirm
  // sheet is open for; the actual leave call reuses the same `/crews/:id/leave` this Crew's own
  // chat page already calls, and a left Crew disappears from every list that reads GET /crews
  // (this one, Home's story rail, Home's "In the groups" feed) automatically — that's what
  // membership-scoped queries already do, nothing extra needed to "remove it from the feed".
  const [leaveTarget, setLeaveTarget] = useState<CrewSummary | null>(null);
  const [leaving, setLeaving] = useState(false);

  async function confirmLeave() {
    if (!leaveTarget) return;
    setLeaving(true);
    try {
      await api.post(`/crews/${leaveTarget.id}/leave`);
      setLeaveTarget(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not leave that Crew.');
    } finally {
      setLeaving(false);
    }
  }

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
    setNewCrewImageUrl(null);
    setInviteUrl(null);
    setCrewInterestPreferences([]);
    setTasteError(null);
    setShowCreate(true);
  }

  /** Same add-or-remove-from-array pattern as crews/[id]/page.tsx#toggleInterestPreference —
   *  persists to the Crew's real CrewRecommendationSettings row immediately (this step's Crew
   *  already exists by the time it's shown), so preferencesSetAt gets stamped, and the
   *  guaranteed-first-recommendation trigger fires, the moment the first one lands — not only
   *  once "Continue" is tapped. */
  async function toggleTasteInterest(interestId: string) {
    if (!newCrewId) return;
    const next = crewInterestPreferences.includes(interestId)
      ? crewInterestPreferences.filter((v) => v !== interestId)
      : [...crewInterestPreferences, interestId];
    const prev = crewInterestPreferences;
    setCrewInterestPreferences(next);
    setTasteSaving(true);
    setTasteError(null);
    try {
      await api.patch(`/crews/${newCrewId}/recommendation-settings`, { interestPreferences: next });
    } catch (err) {
      setCrewInterestPreferences(prev); // revert
      setTasteError(err instanceof ApiError ? err.message : 'Could not save that — check your connection and try again.');
    } finally {
      setTasteSaving(false);
    }
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
      // Name -> give it a look -> invite: creation is a short social flow with a real identity
      // step, not "name field -> submit" (the brief's own quoted example of what to fix).
      setStep('look');
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
    <div className="v2 v2-app-shell">
      <div className="v2-shell-desktop">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 22 }}>
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

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          {crews === null && !error && (
            <div className="v2-crews-grid">
              {[1, 2].map((i) => (
                <div key={i} className="v2-skeleton" style={{ height: 220, borderRadius: 'var(--v2-r-lg)' }} />
              ))}
            </div>
          )}

          {crews && crews.length > 0 && (
            <div className="v2-crews-grid">
              {crews.map((crew, i) => {
                const activity = crewActivityText(crew);
                // Crew theme art (crewArtStyle) is deliberately shown ONLY inside a Crew's own
                // chat and Home's story rail — the Crews list falls back straight to the plain
                // identity-gradient mark for a Crew with no real photo, same as everywhere else
                // outside those two places. See CrewMark's own `allowThemeArt` comment.
                const realPhoto = crew.imageUrl && !isCrewArtUrl(crew.imageUrl) ? crew.imageUrl : null;
                return (
                  // A plain relative wrapper, not the tile's own interactive element — the Leave
                  // button below is a real sibling to the Link (both absolutely positioned inside
                  // it), never a <button> nested inside the <a> the Link renders, which is invalid
                  // HTML and unreliable for stopping the click from also navigating.
                  <div key={crew.id} className="fade-up v2-stagger" style={{ position: 'relative', ['--stagger-i' as string]: i }}>
                  <Link
                    href={`/crews/${crew.id}`}
                    className="v2-hoverable"
                    style={{
                      display: 'block', position: 'relative', height: 220, borderRadius: 'var(--v2-r-lg)', overflow: 'hidden',
                      boxShadow: 'var(--v2-shadow-sm)',
                      background: realPhoto ? `url("${realPhoto}") center/cover` : identityGradient(crew.name, 190),
                    }}
                  >
                    <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(0,0,0,0) 32%, rgba(0,0,0,0.68) 100%)' }} />
                    <div style={{ position: 'absolute', top: 12, left: 12 }}>
                      <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={34} />
                      {/* Real, persisted unread state — see apps/api/src/services/crew.ts
                          #crewSummaryExtras. Never faked client-side. */}
                      {crew.unreadCount > 0 && (
                        <div
                          className="v2-pop-in"
                          style={{
                            position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, padding: '0 4px', borderRadius: 9,
                            background: 'var(--v2-pop)', color: '#fff', fontSize: 9.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 0 0 2px rgba(0,0,0,0.55)',
                          }}
                        >
                          {crew.unreadCount > 9 ? '9+' : crew.unreadCount}
                        </div>
                      )}
                    </div>
                    {activity.tone === 'plan' && (
                      <div style={{ position: 'absolute', top: 12, right: 12, fontSize: 10, fontWeight: 800, letterSpacing: '0.02em', textTransform: 'uppercase', color: '#fff', background: 'var(--v2-green)', padding: '4px 9px', borderRadius: 100 }}>
                        Locked
                      </div>
                    )}
                    {activity.tone === 'deciding' && (
                      <div className="v2-pop-in" style={{ position: 'absolute', top: 12, right: 12, fontSize: 10, fontWeight: 800, letterSpacing: '0.02em', textTransform: 'uppercase', color: '#fff', background: 'var(--v2-pop)', padding: '4px 9px', borderRadius: 100 }}>
                        Voting
                      </div>
                    )}
                    <div style={{ position: 'absolute', left: 14, right: 14, bottom: 12 }}>
                      <div className="v2-display" style={{ fontSize: 20, color: '#fff', lineHeight: 1.08, marginBottom: 6, textShadow: '0 1px 4px rgba(0,0,0,0.35)' }}>
                        {crew.name}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <div className="stack">
                          {crew.members.slice(0, 4).map((m, mi) => (
                            <div key={mi} style={{ marginLeft: mi === 0 ? 0 : -8, borderRadius: '50%', boxShadow: '0 0 0 2px rgba(0,0,0,0.4)' }}>
                              <PersonAvatar name={m.user.displayName} email={m.user.email} photoUrl={m.user.avatarUrl} size={22} />
                            </div>
                          ))}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>
                          {crew.members.length} {crew.members.length === 1 ? 'person' : 'people'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: crew.unreadCount > 0 ? 800 : 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {activity.text}
                      </div>
                    </div>
                  </Link>
                  {/* Real, reported gap: leaving a Crew only lived inside that Crew's own chat
                      (avatar cluster -> members sheet -> scroll to the bottom) — nowhere on the
                      list of Crews itself. Sits below the Locked/Voting badge when one's present
                      rather than fighting it for the same corner. */}
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setLeaveTarget(crew); }}
                    aria-label={`More options for ${crew.name}`}
                    className="v2-tap-feedback"
                    style={{
                      position: 'absolute', top: activity.tone === 'plan' || activity.tone === 'deciding' ? 46 : 12, right: 12,
                      width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer',
                      background: 'rgba(0,0,0,0.38)', backdropFilter: 'blur(4px)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <IconMore size={15} />
                  </button>
                  </div>
                );
              })}
            </div>
          )}

          {crews?.length === 0 && (
            <div style={{ textAlign: 'center', padding: '56px 12px 32px' }}>
              <h2 className="v2-display" style={{ fontSize: 26, marginBottom: 10, lineHeight: 1.15 }}>No Crews yet.</h2>
              <p className="v2-muted" style={{ marginBottom: 22, lineHeight: 1.6, maxWidth: 280, marginInline: 'auto' }}>
                Start one, or ask a friend for their invite link.
              </p>
              <button className="v2-btn v2-btn-brand" onClick={openCreate}>Start a Crew</button>
            </div>
          )}
        </div>
      </div>

      <BottomSheet open={showCreate} onClose={() => !creating && setShowCreate(false)}>
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
        ) : step === 'look' ? (
          <div style={{ textAlign: 'center' }}>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{name}</div>
            <h2 className="v2-display" style={{ fontSize: 20, marginBottom: 6 }}>Give it a look</h2>
            <p className="v2-muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
              A photo makes {name} instantly recognisable in your Crews list. You can always change it later.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
              {newCrewId && (
                <MediaUploadButton
                  uploadPath={`/crews/${newCrewId}/image`}
                  deletePath={`/crews/${newCrewId}/image`}
                  shape="squircle"
                  size={96}
                  presetKind="crew"
                  value={newCrewImageUrl}
                  name={name}
                  onChange={setNewCrewImageUrl}
                >
                  <CrewMark name={name} imageUrl={newCrewImageUrl} size={96} />
                </MediaUploadButton>
              )}
            </div>
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={() => setStep('taste')}>
              Continue
            </button>
          </div>
        ) : step === 'taste' ? (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{name}</div>
            <h2 className="v2-display" style={{ fontSize: 20, marginBottom: 6 }}>What&rsquo;s {name} actually into?</h2>
            <p className="v2-muted" style={{ marginBottom: 16, fontSize: 13.5, lineHeight: 1.5 }}>
              Set this once, as the Crew&rsquo;s own taste — Plot won&rsquo;t find or suggest anything until it&rsquo;s set. Pick at
              least one, either way; you can tailor it any time after.
            </p>
            {tasteError && <p style={{ color: 'var(--v2-error)', fontSize: 12.5, marginBottom: 10 }}>{tasteError}</p>}
            {newCrewId && (
              <CrewTuneContent
                crewId={newCrewId}
                interestPreferences={crewInterestPreferences}
                onToggle={toggleTasteInterest}
                onAiApplied={setCrewInterestPreferences}
                saving={tasteSaving}
              />
            )}
            <button
              className="v2-btn v2-btn-brand"
              style={{ width: '100%', marginTop: 18 }}
              disabled={crewInterestPreferences.length === 0 || tasteSaving}
              onClick={() => setStep('invite')}
            >
              {crewInterestPreferences.length === 0 ? 'Pick at least one to continue' : 'Continue'}
            </button>
          </div>
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

      <BottomSheet open={Boolean(leaveTarget)} onClose={() => !leaving && setLeaveTarget(null)}>
        {leaveTarget && (
          <div style={{ textAlign: 'center', padding: '4px 4px 8px' }}>
            <CrewMark name={leaveTarget.name} imageUrl={leaveTarget.imageUrl} size={56} />
            <h2 className="v2-display" style={{ fontSize: 19, margin: '14px 0 6px' }}>Leave {leaveTarget.name}?</h2>
            <p className="v2-muted" style={{ marginBottom: 22, lineHeight: 1.6, fontSize: 13.5 }}>
              You&rsquo;ll stop seeing their messages and plans, and they won&rsquo;t see yours. You&rsquo;d need a
              new invite to come back.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={confirmLeave} disabled={leaving} className="v2-btn v2-btn-brand" style={{ flex: 1 }}>
                {leaving ? 'Leaving…' : 'Leave'}
              </button>
              <button onClick={() => setLeaveTarget(null)} disabled={leaving} className="v2-btn v2-btn-ghost" style={{ flex: 1 }}>
                Stay
              </button>
            </div>
          </div>
        )}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
