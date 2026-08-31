import Link from 'next/link';

/**
 * Next's default 404 is a bare white page with no relation to the rest of the app — a jarring
 * dead end (a bad invite link, a deleted Plan, a typo'd URL) that would otherwise be the one
 * moment the whole "this feels like one coherent app" illusion breaks.
 */
export default function NotFound() {
  return (
    <div className="v2">
      <div className="v2-page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh', textAlign: 'center', alignItems: 'center' }}>
        <div
          style={{
            width: 40, height: 40, borderRadius: 12, background: 'var(--v2-plum)', color: 'var(--v2-brand)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', marginBottom: 20, fontFamily: 'Bricolage Grotesque, sans-serif', fontWeight: 800, fontSize: 17,
          }}
        >
          P
        </div>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🧭</div>
        <h1 className="v2-display" style={{ fontSize: 21, marginBottom: 8 }}>Nothing here.</h1>
        <p className="v2-muted" style={{ marginBottom: 22, maxWidth: 260 }}>
          This link might be old, or the Plan/Crew it pointed to isn&rsquo;t around anymore.
        </p>
        <Link href="/home" className="v2-btn v2-btn-brand">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
