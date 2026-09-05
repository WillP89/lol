'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useScrollReveal } from '@/lib/useScrollReveal';
import { usePointerParallax } from '@/lib/usePointerParallax';
import { MarketingAtmosphere } from '@/components/MarketingAtmosphere';
import { IconChat, IconPoll, IconLock } from '@/components/icons';

/**
 * THE LANDING PAGE — hard revamp (not a tuning pass on the previous light-background version):
 * real, direct feedback was "doesn't pop enough... compare against the best in the space... I
 * want it to feel ALIVE." Three changes carry that: (1) the whole entrance now commits to the
 * dark, always-on `.v2-marketing-dark` palette (see globals.css's own comment on why that's a
 * different decision from the product's "never auto-dark" rule) so the accent colours actually
 * read as electric; (2) the hero's three-card collage is replaced by a full-bleed, continuously
 * scrolling marquee of plan cards — motion that never stops regardless of the cursor, the single
 * biggest "feels alive" lever available; (3) the one coloured word in the headline now cycles
 * through a short list of real plan types, so the very first thing on the page is already moving
 * before anyone touches anything. See MarketingAtmosphere.tsx for the shared backdrop system
 * (aurora + particles + cursor spotlight + grain) both this page and /auth now share.
 */
export default function LandingClient() {
  useScrollReveal();
  // The hero's own parallax root — see lib/usePointerParallax.ts. Every layer below (aurora,
  // spotlight, particle field, the marquee) reads the `--px`/`--py` this writes, each with its
  // own depth multiplier, so the whole scene shifts together but at different rates as the
  // pointer moves — the actual "responds to you" depth cue, not just ambient drift on a timer.
  const heroRef = useRef<HTMLDivElement>(null);
  usePointerParallax(heroRef);

  const word = useCyclingWord(PLAN_WORDS, 2200);

  return (
    <div className="v2 v2-marketing-dark" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      {/* The atmosphere now wraps the header too — real, screenshot-caught bug on the way here:
          with the header outside this container, the vivid aurora had a hard, flat-black band
          above it exactly where the header sat, breaking the full-bleed immersive read the whole
          point of this revamp was to land. One continuous scene from the very top of the
          viewport now, header included. */}
      <div ref={heroRef} style={{ position: 'relative', minHeight: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <MarketingAtmosphere />
        <div className="v2-hero-core" style={{ transform: 'translate3d(calc(var(--px, 0) * 24px), calc(var(--py, 0) * 24px), 0)' }} />

        <div style={{ position: 'relative', zIndex: 1, padding: '22px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
          <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 900, fontSize: 21, letterSpacing: '-0.02em', color: 'var(--v2-ink)' }}>Plot</div>
          <Link href="/auth" style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--v2-ink-muted)' }}>Sign in</Link>
        </div>

        <div style={{ position: 'relative', zIndex: 1, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', padding: '20px 28px 0', maxWidth: 1080, margin: '0 auto' }}>
          <div className="fade-up" style={{ maxWidth: 640 }}>
            <div
              className="v2-eyebrow"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 18,
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)',
                padding: '7px 14px', borderRadius: 100, color: 'var(--v2-ink-muted)',
              }}
            >
              <span className="v2-live-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--v2-pop)', ['--dot-glow' as string]: 'rgba(255,47,126,0.6)' }} />
              Built for real Crews, not solo calendars
            </div>
            <h1 style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 900, fontSize: 'clamp(42px, 7vw, 80px)', lineHeight: 0.96, letterSpacing: '-0.03em', marginBottom: 22, color: 'var(--v2-ink)' }}>
              Actually<br />
              <span style={{ color: 'var(--v2-pop)' }}>make</span>{' '}
              <span key={word} className="v2-word-cycle">{word}</span>
            </h1>
            <p style={{ fontSize: 17.5, lineHeight: 1.55, color: 'var(--v2-ink-muted)', marginBottom: 34, maxWidth: 440 }}>
              Plot turns the group chat into something you&rsquo;re actually doing — for your Crew, not just for you.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <Link href="/auth" className="v2-btn v2-btn-brand v2-mkt-cta" style={{ padding: '17px 32px', fontSize: 15.5 }}>
                Get started
              </Link>
              <Link href="/auth" style={{ fontSize: 14, fontWeight: 700, color: 'var(--v2-ink)' }}>
                Already on Plot?
              </Link>
            </div>
          </div>
        </div>

        {/* THE MARQUEE — full-bleed, continuously scrolling, never stops regardless of the
            cursor. Real, reported bug this replaces: a static 3-card collage that only moved on
            hover or its own gentle idle bob read as "decoration", not "alive". The track below
            renders PLAN_CARDS twice back to back and animates exactly -50% (see globals.css's own
            comment) so the loop point is invisible. Slight -2deg tilt for the same tactile,
            Partiful-style personality the old collage had, now genuinely in motion at all times. */}
        <div
          className="fade-up"
          style={{ position: 'relative', zIndex: 1, marginTop: 56, marginBottom: 40, transform: 'rotate(-1.4deg)' }}
        >
          <div className="v2-marquee">
            <div className="v2-marquee-track">
              {[...PLAN_CARDS, ...PLAN_CARDS].map(([when, what, color], i) => (
                <MarqueeCard key={`${what}-${i}`} when={when} what={what} color={color} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* THE LOOP — each step reveals as you scroll to it. */}
      <div style={{ padding: '90px 28px 0', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
        <div className="v2-reveal v2-eyebrow" style={{ marginBottom: 10 }}>How it actually works</div>
        <h2 className="v2-reveal v2-display" style={{ fontSize: 'clamp(28px, 4vw, 42px)', marginBottom: 44, maxWidth: 560, color: 'var(--v2-ink)', ['--reveal-i' as string]: 1 }}>
          Not another calendar app. The decision itself lives in the chat.
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 24 }}>
          {[
            { Icon: IconChat, tint: 'rgba(47,138,255,0.16)', ink: '#5fa8ff', title: 'Talk', desc: 'Someone throws an idea into the group — a gig, a pub, a place they found.', n: '01' },
            { Icon: IconPoll, tint: 'rgba(124,92,252,0.16)', ink: '#a794ff', title: 'Decide', desc: 'The Crew votes right there — in, maybe, or can’t make it. You watch it converge.', n: '02' },
            { Icon: IconLock, tint: 'rgba(52,211,153,0.18)', ink: '#3ddc94', title: 'Go', desc: 'Lock it in. It becomes a real Plan — on Home, on Plans, in everyone’s pocket.', n: '03' },
          ].map(({ Icon, tint, ink, title, desc, n }, i) => (
            <div key={title} className="v2-reveal v2-card v2-mkt-step-card" style={{ padding: '26px 22px', position: 'relative', overflow: 'hidden', ['--reveal-i' as string]: i + 1 }}>
              <div className="v2-display" style={{ position: 'absolute', top: -6, right: 14, fontSize: 56, fontWeight: 900, color: 'var(--v2-ink)', opacity: 0.05, lineHeight: 1 }}>{n}</div>
              <div style={{ width: 46, height: 46, borderRadius: 14, background: tint, color: ink, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14, position: 'relative' }}>
                <Icon size={22} />
              </div>
              <div className="v2-display" style={{ fontSize: 17.5, marginBottom: 6, color: 'var(--v2-ink)', position: 'relative' }}>{title}</div>
              <div className="v2-muted" style={{ fontSize: 13.5, lineHeight: 1.55, position: 'relative' }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* A quiet strip of texture/motion between the two static sections — a small, honest touch
          (real plan categories the app actually covers, not a fabricated stats ticker) that keeps
          the page's continuous-motion rule alive between the two "how it works"/"what it feels
          like" blocks rather than going flat and static for a whole scroll length. */}
      <div className="v2-reveal" style={{ margin: '64px 0', opacity: 0.7 }}>
        <div className="v2-marquee">
          <div className="v2-marquee-track v2-marquee-reverse" style={{ animationDuration: '26s' }}>
            {[...WHAT_PLOT_COVERS, ...WHAT_PLOT_COVERS].map((w, i) => (
              <span key={`${w}-${i}`} className="v2-display" style={{ fontSize: 22, fontWeight: 800, color: 'var(--v2-ink-dim)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 16 }}>
                {w}
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--v2-ink-dim)' }} />
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* THE ACTUAL PRODUCT, not a mockup screenshot — a live rendering of the real shared-idea
          card component's visual states (proposed -> converging -> locked, same as
          crews/[id]/page.tsx's EventCard) so a signed-out visitor can see the interaction system
          itself, not just a tagline claiming it exists. */}
      <div style={{ padding: '0 28px 100px', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
        <div className="v2-reveal v2-eyebrow" style={{ marginBottom: 10 }}>What it feels like</div>
        <h2 className="v2-reveal v2-display" style={{ fontSize: 'clamp(28px, 4vw, 42px)', marginBottom: 40, maxWidth: 620, color: 'var(--v2-ink)', ['--reveal-i' as string]: 1 }}>
          An idea has a life. It goes from &ldquo;shared&rdquo; to &ldquo;happening&rdquo; in front of you.
        </h2>
        <LandingLifecycleDemo />
      </div>

      <div style={{ position: 'relative', padding: '90px 28px 100px', textAlign: 'center', overflow: 'hidden' }}>
        {/* One more glow moment before the page ends, so it doesn't fade out into a flat void
            after everything above — a compact echo of the hero's own aurora, not the full
            particle/spotlight system (this section has one job: get the tap). */}
        <div aria-hidden style={{ position: 'absolute', inset: '-20% -10%', background: 'conic-gradient(from 180deg at 50% 60%, var(--v2-pop), var(--v2-confetti-2), transparent 55%, var(--v2-confetti-4), var(--v2-pop))', filter: 'blur(110px) saturate(1.3)', opacity: 0.32 }} />
        <div className="v2-reveal" style={{ position: 'relative', maxWidth: 1080, margin: '0 auto' }}>
          <h2 className="v2-display" style={{ fontSize: 'clamp(28px, 4.5vw, 44px)', marginBottom: 20, color: 'var(--v2-ink)' }}>Get your Crew in.</h2>
          <Link href="/auth" className="v2-btn v2-btn-brand v2-mkt-cta" style={{ padding: '17px 34px', fontSize: 15.5 }}>
            Get started
          </Link>
        </div>
      </div>
    </div>
  );
}

const PLAN_WORDS = ['the plan.', 'the gig.', 'the pub run.', 'brunch.', 'game night.', 'the trip.'];

/** A small, self-contained timer hook — same "self-playing, no real network" pattern this file
 *  already uses for `LandingLifecycleDemo` below, applied to the headline's one coloured word so
 *  the very first thing on the page is already alive before a visitor does anything at all. */
function useCyclingWord(words: string[], intervalMs: number): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % words.length), intervalMs);
    return () => clearInterval(t);
  }, [words.length, intervalMs]);
  return words[i];
}

const PLAN_CARDS: [string, string, string][] = [
  ['Sat, 8pm', "Fred's flat", 'var(--v2-confetti-2)'],
  ['Fri, 7pm', 'Gig night', 'var(--v2-confetti-1)'],
  ['Sun, 1pm', 'Roast & pub', 'var(--v2-confetti-5)'],
  ['Thu, 9pm', 'Quiz night', 'var(--v2-confetti-3)'],
  ['Sat, 3pm', 'Five-a-side', 'var(--v2-confetti-4)'],
  ['Fri, 10pm', 'Late one', 'var(--v2-confetti-6)'],
];

const WHAT_PLOT_COVERS = ['GIGS', 'BRUNCH', 'PUB QUIZZES', 'FIVE-A-SIDE', 'LATE ONES', 'ROAD TRIPS', 'HOUSE PARTIES', 'GAME NIGHT'];

/** One tile in the hero's marquee — same tilt/hover language `.v2-collage-card` already
 *  established, just no longer idling on its own timer since the whole row is now permanently in
 *  motion via the shared track animation (see globals.css's `.v2-marquee-track`). */
function MarqueeCard({ when, what, color }: { when: string; what: string; color: string }) {
  return (
    <div
      className="v2-collage-card"
      style={{
        flex: '0 0 auto', width: 148, height: 208, borderRadius: 18, padding: '16px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        background: `linear-gradient(155deg, ${color}, rgba(8,8,10,0.9))`,
        boxShadow: 'var(--v2-shadow-lg)',
        color: '#fff',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, opacity: 0.85, marginBottom: 4 }}>{when}</div>
      <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 800, fontSize: 17.5, lineHeight: 1.15 }}>{what}</div>
    </div>
  );
}

/** A self-playing, looping mock of the real EventCard life cycle from the Crew chat — the exact
 * same three states (shared -> converging -> locked), just driven by a local timer instead of
 * real votes, since a logged-out landing page has no real Crew to show. Purely presentational;
 * no network calls, no fabricated claim of being live data. */
function LandingLifecycleDemo() {
  const [stage, setStage] = useState(0); // 0 shared, 1 converging, 2 locked
  useEffect(() => {
    const t = setInterval(() => setStage((s) => (s + 1) % 3), 2200);
    return () => clearInterval(t);
  }, []);
  const avatars = [
    { initial: 'R', color: 'var(--v2-confetti-2)' },
    { initial: 'S', color: 'var(--v2-confetti-3)' },
    { initial: 'C', color: 'var(--v2-confetti-4)' },
  ];
  const shown = stage === 0 ? 0 : stage === 1 ? 2 : 3;
  return (
    <div className="v2-reveal" style={{ ['--reveal-i' as string]: 2, maxWidth: 320 }}>
      <div className={stage === 2 ? 'v2-confirm-transition' : undefined} style={{ borderRadius: 'var(--v2-r-md)', overflow: 'hidden', background: stage === 2 ? 'var(--v2-green)' : 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-lg)', transition: 'background 0.4s ease' }}>
        <div style={{ height: 110, background: 'linear-gradient(160deg, #ff2f7e 0%, #7c5cfc 45%, #0c0c0d 100%)' }} />
        <div style={{ padding: '16px 18px' }}>
          {stage === 2 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="v2-pop-in" style={{ fontSize: 20, color: '#fff' }}>✓</span>
              <span style={{ fontWeight: 800, fontSize: 16, color: '#fff' }}>Locked in — Jorja Smith DJ Set</span>
            </div>
          ) : (
            <>
              <div className="v2-display" style={{ fontSize: 16, marginBottom: 6, color: 'var(--v2-ink)' }}>Jorja Smith DJ Set</div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: stage === 1 ? 'var(--v2-ink)' : 'var(--v2-ink-muted)', marginBottom: 8 }}>
                {stage === 0 ? 'Robin shared this — who’s in?' : `${shown} in — likely happening`}
              </div>
              <div className="stack">
                {avatars.slice(0, shown).map((a) => (
                  <div key={a.initial} className="v2-pop-in" style={{ width: 22, height: 22, borderRadius: '50%', marginLeft: -6, fontSize: 9, fontWeight: 800, color: '#fff', background: a.color, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--v2-surface)' }}>
                    {a.initial}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
