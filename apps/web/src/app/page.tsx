import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * The entrance — a real product opening, not a login form (brief: "people decide whether they
 * trust an application within seconds"). One identity moment, one line of thesis, two clear
 * actions. See globals.css's V2 system + docs/DECISIONS.md#v2-art-direction.
 */
export default function LandingPage() {
  if (cookies().get('plot_session')) {
    redirect('/home');
  }

  return (
    <div className="v2" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: '40px 24px', position: 'relative', overflow: 'hidden' }}>
        {/* Ambient colour, not a photo — the same category-art palette the rest of the product
            uses, so the very first thing anyone sees already belongs to Plot's own language. */}
        <div
          aria-hidden
          className="v2-ambient-glow"
          style={{
            position: 'absolute', inset: '-20%', zIndex: 0,
            background:
              'radial-gradient(46% 38% at 20% 15%, rgba(255,61,90,0.16), transparent 60%), radial-gradient(50% 42% at 85% 12%, rgba(91,61,240,0.14), transparent 62%), radial-gradient(55% 45% at 50% 100%, rgba(28,122,82,0.10), transparent 60%)',
          }}
        />
        <div className="fade-up" style={{ position: 'relative', zIndex: 1, maxWidth: 380 }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--v2-plum)', color: 'var(--v2-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 26px', fontFamily: 'Bricolage Grotesque, sans-serif', fontWeight: 800, fontSize: 28, boxShadow: 'var(--v2-shadow-lg)' }}>
            P
          </div>
          <h1 className="v2-display" style={{ fontSize: 'clamp(30px, 7vw, 40px)', lineHeight: 1.08, marginBottom: 14 }}>
            Actually make<br />the plan.
          </h1>
          <p className="v2-muted" style={{ fontSize: 15.5, lineHeight: 1.55, marginBottom: 34 }}>
            Plot turns the group chat into something you&rsquo;re actually doing — for your Crew, not just for you.
          </p>
          <Link href="/auth" className="v2-btn v2-btn-brand" style={{ width: '100%', marginBottom: 10, padding: '16px 22px', fontSize: 15.5 }}>
            Get started
          </Link>
          <Link href="/auth" className="v2-muted" style={{ fontSize: 13.5, fontWeight: 700 }}>
            Already on Plot? Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
