import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default function HomePage() {
  // A returning, already-signed-in visitor has no reason to see the marketing pitch again —
  // straight to their Crews. Same session-cookie check the Plan Card page already uses.
  if (cookies().get('plot_session')) {
    redirect('/crews');
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh' }}>
      <div className="wordmark" style={{ fontSize: 'clamp(38px, 11vw, 52px)', fontWeight: 900, marginBottom: 18 }}>
        Plot<span>·</span>
      </div>
      <h1 style={{ fontSize: 26, lineHeight: 1.2, marginBottom: 14 }}>
        Life&rsquo;s too short for the group chat that goes nowhere.
      </h1>
      <p className="muted" style={{ marginBottom: 28, fontSize: 15 }}>
        Plot turns &ldquo;we should do something&rdquo; into plans that actually happen — for your Crew, not just for you.
      </p>
      <Link href="/auth" className="btn btn-primary">
        Get started
      </Link>
    </div>
  );
}
