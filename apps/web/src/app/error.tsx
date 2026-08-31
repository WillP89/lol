'use client';

/**
 * Next's error boundary for anything that throws during render — without this, a real user
 * would see either a raw stack trace (dev) or a generic "Application error" page (prod) with
 * zero relation to the rest of the app and no way back in. Errors this catches are genuine
 * bugs (a null-deref, a bad assumption about API shape), not expected API failures — those are
 * already handled per-page with a `setError`/error-text pattern instead.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="v2">
      <div className="v2-page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh', textAlign: 'center', alignItems: 'center' }}>
        <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 900, letterSpacing: '-0.02em', fontSize: 20, marginBottom: 28 }}>Plot</div>
        <h1 className="v2-display" style={{ fontSize: 21, marginBottom: 8 }}>Something went wrong.</h1>
        <p className="v2-muted" style={{ marginBottom: 22, maxWidth: 260 }}>
          That&rsquo;s on us, not you. Try again — if it keeps happening, come back a bit later.
        </p>
        <button className="v2-btn v2-btn-brand" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
