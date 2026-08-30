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
  themeColor: '#100f17',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
