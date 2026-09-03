import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plot — the decision layer for real-world social life',
  description: "Turns 'we should do something' into a confirmed plan for your Crew.",
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon-32.png',
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    // Enables "Add to Home Screen" full-screen (standalone) mode on iOS Safari, with our
    // own icon and title instead of a generic Safari bookmark. See docs/DEPLOYMENT.md —
    // this only takes effect once the app is served over a real HTTPS URL.
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Plot',
  },
};

export const viewport: Viewport = {
  // A real, not cosmetic, pair — Safari colours the status-bar/notch area from this, so a
  // static light value left it visibly wrong (a bright bar over dark content) the moment dark
  // mode is active. `media` is the browser's own live prefers-color-scheme read; the explicit
  // toggle (ThemeProvider below) additionally forces the matching one on <meta name=theme-color>
  // directly, since this static list alone can't see the in-app override, only the OS setting.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f6f4' },
    { media: '(prefers-color-scheme: dark)', color: '#131316' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Real, well-known problem this avoids: reading the theme choice and applying `data-theme` from
// a normal React effect happens AFTER first paint — the page would render in the wrong theme for
// one visible frame, then flip, on every load. This runs synchronously in <head>, before any
// content paints, so there's never a flash. `try/catch` because `localStorage` can throw in a
// locked-down context (private browsing in some older Safari versions) — falling through to
// system preference (or nothing at all, i.e. light) is the correct fail-safe, not a crash.
const THEME_INIT_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('plot-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
