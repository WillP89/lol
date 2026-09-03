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
  // Real, not cosmetic: Safari colours the status-bar/notch area from this. Used to be a
  // `prefers-color-scheme`-keyed pair so the OS's own dark setting alone could flip it — removed
  // per the same explicit "never auto-switch to dark" decision as lib/theme.ts (light is the one,
  // only default regardless of the OS setting). A single, unconditional light value now; THEME_
  // INIT_SCRIPT below overwrites this tag's `content` directly, synchronously before first paint,
  // on the one path that's allowed to make it dark — a real, explicitly stored `data-theme=dark`
  // choice from the toggle, never the OS.
  themeColor: '#f6f6f4',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // THE real, platform-level fix for the on-screen-keyboard-in-chat class of bug this session
  // spent two whole rounds chasing in JS (crews/[id]/page.tsx's own useVisualViewportHeight +
  // position:fixed + translateY dance) — and which STILL wasn't reliable on a real device inside
  // Gmail's in-app browser (a different WKWebView host than plain Safari, evidently with its own
  // quirks in exactly how/when it fires visualViewport resize events). `interactive-widget:
  // resizes-content` (Safari 17.4+/iOS 17.4+, Chrome 108+ — both comfortably old news by now) is
  // the standards-track instruction that tells the browser itself to genuinely resize the LAYOUT
  // viewport — and therefore plain `100dvh` — for the on-screen keyboard, the same way it
  // already does for the address bar collapsing. With this set, the browser does the real work
  // at the platform level instead of the app trying to reconstruct it from `visualViewport`
  // events after the fact — no app-level timing/ordering assumption to get subtly wrong per
  // WebView flavour. The existing JS fallback (useVisualViewportHeight) stays in place for the
  // rare browser that doesn't understand this yet — it becomes a safe no-op wherever this meta
  // is honoured (visualViewport.height already equals the resized dvh in that case, offsetTop
  // stays 0), never a second, conflicting resize on top of this one.
  interactiveWidget: 'resizes-content',
};

// Real, well-known problem this avoids: reading the theme choice and applying `data-theme` from
// a normal React effect happens AFTER first paint — the page would render in the wrong theme for
// one visible frame, then flip, on every load. This runs synchronously in <head>, before any
// content paints, so there's never a flash. `try/catch` because `localStorage` can throw in a
// locked-down context (private browsing in some older Safari versions) — falling through to
// light (the only default now — see lib/theme.ts) is the correct fail-safe, not a crash. Only
// ever reacts to a genuinely STORED 'dark' — never reads prefers-color-scheme, so there is no
// code path left anywhere that lets the OS's own setting pick dark for someone who never chose
// it themselves. Also fixes up the `<meta name="theme-color">` tag Next's static metadata
// already rendered (always the light value — see the `viewport` export above) so a real, stored
// dark choice colours the status bar correctly too, without needing a live OS media query for it.
const THEME_INIT_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('plot-theme');
    if (stored === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', '#131316');
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
