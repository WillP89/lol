'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useScrollReveal } from '@/lib/useScrollReveal';
import { IconChat, IconPoll, IconLock } from '@/components/icons';

/**
 * The interactive body of the landing page — split out from page.tsx so the server component
 * there can keep doing its `cookies()`-based redirect (an already-signed-in visitor never sees
 * this at all, checked server-side before any HTML ships, no client-side flash) while this half
 * gets the client hooks (useScrollReveal, the mock card's own tiny timer) it needs.
 *
 * Real gap this fixes, not a re-theme: the page used to be exactly one 100vh screen with nothing
 * below the fold — literally nothing to scroll. Below now has real content, including an actual
 * mock of the shared-idea life cycle (the same visual states as crews/[id]/page.tsx's real
 * EventCard) so a signed-out visitor can SEE the interaction system this session built, not just
 * read a tagline about it. Every section below the hero carries `.v2-reveal` so scrolling down
 * is genuinely, visibly not static.
 */
export default function LandingClient() {
  useScrollReveal();

  const cards: [string, string, string][] = [
    ['Sat, 8pm', "Fred's flat", 'var(--v2-confetti-2)'],
    ['Fri, 7pm', 'Gig night', 'var(--v2-confetti-1)'],
    ['Sun, 1pm', 'Roast & pub', 'var(--v2-confetti-5)'],
  ];

  return (
    <div className="v2" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '22px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
        <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 900, fontSize: 21, letterSpacing: '-0.02em' }}>Plot</div>
        <Link href="/auth" style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--v2-ink-muted)' }}>Sign in</Link>
      </div>

      <div
        style={{
          minHeight: 'calc(100dvh - 76px)', display: 'flex', alignItems: 'center', gap: 48, flexWrap: 'wrap',
          padding: '24px 28px 60px', maxWidth: 1080, margin: '0 auto', width: '100%',
        }}
      >
        <div className="fade-up" style={{ flex: '1 1 420px', minWidth: 300 }}>
          <h1 style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 900, fontSize: 'clamp(40px, 6.5vw, 72px)', lineHeight: 0.96, letterSpacing: '-0.03em', marginBottom: 22 }}>
            Actually<br />
            <span style={{ color: 'var(--v2-pop)' }}>make</span> the plan.
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.55, color: 'var(--v2-ink-muted)', marginBottom: 36, maxWidth: 420 }}>
            Plot turns the group chat into something you&rsquo;re actually doing — for your Crew, not just for you.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
            <Link href="/auth" className="v2-btn v2-btn-brand" style={{ padding: '16px 30px', fontSize: 15.5 }}>
              Get started
            </Link>
            <Link href="/auth" style={{ fontSize: 14, fontWeight: 700, color: 'var(--v2-ink)' }}>
              Already on Plot?
            </Link>
          </div>
        </div>

        {/* A small collage of rotated "plan card" tiles — Partiful's own invite-card device,
            scaled down: colour and personality living in content, not in the chrome around it.
            Each tile straightens and lifts on hover/tap (pure CSS — see .v2-collage-card) and
            the whole collage staggers in on load. */}
        <div aria-hidden style={{ flex: '0 0 auto', display: 'flex', gap: 14, margin: '0 auto', transform: 'rotate(-2deg)' }}>
          {cards.map(([when, what, color], i) => (
            <div
              key={what}
              className="fade-up v2-stagger v2-collage-card"
              style={{
                width: 120, height: 168, borderRadius: 18, padding: '14px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                background: `linear-gradient(155deg, ${color}, rgba(12,12,13,0.85))`,
                boxShadow: 'var(--v2-shadow-lg)',
                ['--tilt' as string]: `${i === 1 ? 3 : i === 0 ? -6 : 7}deg`,
                ['--lift' as string]: `${i === 1 ? -10 : 6}px`,
                ['--stagger-i' as string]: i,
                transform: 'rotate(var(--tilt)) translateY(var(--lift))',
                color: '#fff',
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, marginBottom: 3 }}>{when}</div>
              <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 800, fontSize: 15.5, lineHeight: 1.15 }}>{what}</div>
            </div>
          ))}
        </div>
      </div>

      {/* THE LOOP — was three cramped columns squeezed under the fold; now its own considered
          section, each step revealing as you scroll to it. */}
      <div style={{ padding: '90px 28px', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
        <div className="v2-reveal v2-eyebrow" style={{ marginBottom: 10 }}>How it actually works</div>
        <h2 className="v2-reveal v2-display" style={{ fontSize: 'clamp(28px, 4vw, 42px)', marginBottom: 44, maxWidth: 560, ['--reveal-i' as string]: 1 }}>
          Not another calendar app. The decision itself lives in the chat.
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 24 }}>
          {[
            { Icon: IconChat, tint: 'rgba(47,138,255,0.12)', ink: '#2f8aff', title: 'Talk', desc: 'Someone throws an idea into the group — a gig, a pub, a place they found.' },
            { Icon: IconPoll, tint: 'rgba(124,92,252,0.12)', ink: '#7c5cfc', title: 'Decide', desc: 'The Crew votes right there — in, maybe, or can’t make it. You watch it converge.' },
            { Icon: IconLock, tint: 'rgba(52,211,153,0.14)', ink: '#1b8a5c', title: 'Go', desc: 'Lock it in. It becomes a real Plan — on Home, on Plans, in everyone’s pocket.' },
          ].map(({ Icon, tint, ink, title, desc }, i) => (
            <div key={title} className="v2-reveal v2-card" style={{ padding: '24px 22px', ['--reveal-i' as string]: i + 1 }}>
              <div style={{ width: 44, height: 44, borderRadius: 13, background: tint, color: ink, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                <Icon size={22} />
              </div>
              <div className="v2-display" style={{ fontSize: 17, marginBottom: 6 }}>{title}</div>
              <div className="v2-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* THE ACTUAL PRODUCT, not a mockup screenshot — a live rendering of the real shared-idea
          card component's visual states (proposed -> converging -> locked, same as
          crews/[id]/page.tsx's EventCard) so a signed-out visitor can see the interaction system
          itself, not just a tagline claiming it exists. */}
      <div style={{ padding: '20px 28px 100px', maxWidth: 1080, margin: '0 auto', width: '100%' }}>
        <div className="v2-reveal v2-eyebrow" style={{ marginBottom: 10 }}>What it feels like</div>
        <h2 className="v2-reveal v2-display" style={{ fontSize: 'clamp(28px, 4vw, 42px)', marginBottom: 40, maxWidth: 620, ['--reveal-i' as string]: 1 }}>
          An idea has a life. It goes from &ldquo;shared&rdquo; to &ldquo;happening&rdquo; in front of you.
        </h2>
        <LandingLifecycleDemo />
      </div>

      <div style={{ padding: '0 28px 60px', maxWidth: 1080, margin: '0 auto', width: '100%', textAlign: 'center' }}>
        <div className="v2-reveal">
          <h2 className="v2-display" style={{ fontSize: 'clamp(26px, 4vw, 38px)', marginBottom: 16 }}>Get your Crew in.</h2>
          <Link href="/auth" className="v2-btn v2-btn-brand" style={{ padding: '16px 32px', fontSize: 15.5 }}>
            Get started
          </Link>
        </div>
      </div>
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
