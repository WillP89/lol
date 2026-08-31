import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * The entrance — a real product opening, not a login form (people decide whether they trust an
 * application within seconds). One identity moment, one line of thesis, two clear actions, then
 * a natural handoff into auth. Typography and colour-blocking carry this screen — no gradient
 * wash, no glow, no motion beyond the entrance fade. See docs/DECISIONS.md#plot-design-reset.
 */
export default function LandingPage() {
  if (cookies().get('plot_session')) {
    redirect('/home');
  }

  return (
    <div className="v2" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* A solid ink band, not a photo or a gradient — colour-blocking is the one device this
          screen uses to feel considered, and it costs nothing to render. */}
      <div style={{ background: 'var(--v2-plum)', color: 'var(--v2-plum-ink)', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontStyle: 'italic', fontWeight: 700, fontSize: 20 }}>Plot</div>
        <Link href="/auth" style={{ fontSize: 13, fontWeight: 700, color: 'rgba(246,241,232,0.7)' }}>Sign in</Link>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '48px 28px 60px', maxWidth: 640, margin: '0 auto', width: '100%' }}>
        <div className="fade-up">
          <h1 style={{ fontFamily: 'Fraunces, Georgia, serif', fontWeight: 700, fontSize: 'clamp(38px, 8vw, 68px)', lineHeight: 0.98, letterSpacing: '-0.02em', marginBottom: 22 }}>
            Actually<br />
            <span style={{ fontStyle: 'italic', color: 'var(--v2-brand)' }}>make</span> the plan.
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.55, color: 'var(--v2-ink-muted)', marginBottom: 36, maxWidth: 420 }}>
            Plot turns the group chat into something you&rsquo;re actually doing — for your Crew, not just for you.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <Link href="/auth" className="v2-btn v2-btn-brand" style={{ padding: '16px 30px', fontSize: 15.5 }}>
              Get started
            </Link>
            <Link href="/auth" style={{ fontSize: 14, fontWeight: 700, color: 'var(--v2-ink)' }}>
              Already on Plot?
            </Link>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 28px 40px', maxWidth: 640, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', borderTop: '1px solid var(--v2-line)', paddingTop: 22 }}>
          {[
            ['Talk', 'Someone throws in an idea'],
            ['Decide', 'The Crew votes, in or maybe'],
            ['Go', 'Lock it in, it’s a plan'],
          ].map(([title, desc]) => (
            <div key={title} style={{ minWidth: 140 }}>
              <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 3 }}>{title}</div>
              <div className="v2-muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
