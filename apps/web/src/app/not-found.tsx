import Link from 'next/link';
import { IconCompass } from '@/components/icons';

/**
 * Next's default 404 is a bare white page with no relation to the rest of the app — a jarring
 * dead end (a bad invite link, a deleted Plan, a typo'd URL) that would otherwise be the one
 * moment the whole "this feels like one coherent app" illusion breaks.
 */
export default function NotFound() {
  return (
    <div className="v2">
      <div className="v2-page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100dvh', textAlign: 'center', alignItems: 'center' }}>
        <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 900, letterSpacing: '-0.02em', fontSize: 20, marginBottom: 20 }}>Plot</div>
        <IconCompass size={36} style={{ color: 'var(--v2-ink-dim)', marginBottom: 12 }} />
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
