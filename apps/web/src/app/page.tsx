import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh' }}>
      <div className="eyebrow">Plot</div>
      <h1 style={{ fontSize: 34, lineHeight: 1.15, marginBottom: 14 }}>
        Life&rsquo;s too short for the group chat that goes nowhere.
      </h1>
      <p className="muted" style={{ marginBottom: 28 }}>
        Plot turns &ldquo;we should do something&rdquo; into plans that actually happen — for your Crew, not just for you.
      </p>
      <Link href="/auth" className="btn btn-primary">
        Get started
      </Link>
    </div>
  );
}
