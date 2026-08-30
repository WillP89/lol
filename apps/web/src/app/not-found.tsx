import Link from 'next/link';

/**
 * Next's default 404 is a bare white page with no relation to the rest of the app — a jarring
 * dead end (a bad invite link, a deleted Plan, a typo'd URL) that would otherwise be the one
 * moment the whole "this feels like one coherent app" illusion breaks.
 */
export default function NotFound() {
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh', textAlign: 'center', alignItems: 'center' }}>
      <div className="wordmark" style={{ fontSize: 24, marginBottom: 24 }}>
        Plot<span>·</span>
      </div>
      <div style={{ fontSize: 40, marginBottom: 10 }}>🧭</div>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Nothing here.</h1>
      <p className="muted" style={{ marginBottom: 22, maxWidth: 260 }}>
        This link might be old, or the Plan/Crew it pointed to isn&rsquo;t around anymore.
      </p>
      <Link href="/crews" className="btn btn-primary" style={{ width: 'auto', padding: '12px 24px' }}>
        Back to your Crews
      </Link>
    </div>
  );
}
