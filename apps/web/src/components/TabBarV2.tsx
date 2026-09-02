'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { displayNameOf } from '@/lib/displayName';

/**
 * V2 navigation — Home/Explore/Crew only (see globals.css's "V2 DESIGN SYSTEM" block). A
 * deliberately different silhouette from the original `TabBar`: no text labels anywhere, a
 * floating icon-only pill on mobile with a status dot instead of coloured text, a slim
 * colour-blocked icon rail on desktop instead of a wide list of labelled rows. Same five
 * destinations, same routes — this only replaces how they're presented.
 */
const TABS = [
  {
    href: '/home',
    label: 'Home',
    icon: (
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11.5 12 4l8 7.5M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" />
      </svg>
    ),
  },
  {
    href: '/explore',
    label: 'Discover',
    icon: (
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    ),
  },
  {
    href: '/crews',
    label: 'Crews',
    icon: (
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-3 2.5-5 5-5s5 2 5 5" />
      </svg>
    ),
  },
  {
    href: '/plans',
    label: 'Plans',
    icon: (
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="5" width="16" height="15" rx="3.5" />
        <path d="M8 3v4M16 3v4M4 10h16" />
      </svg>
    ),
  },
  {
    href: '/profile',
    label: 'You',
    icon: (
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M4.5 20c0-3.5 3.5-6 7.5-6s7.5 2.5 7.5 6" />
      </svg>
    ),
  },
];

export function TabBarV2({ hideMobile = false }: { hideMobile?: boolean } = {}) {
  const pathname = usePathname();
  const [me, setMe] = useState<{ displayName: string | null; email: string } | null>(null);
  useEffect(() => {
    api
      .get<{ user: { displayName: string | null; email: string } }>('/users/me')
      .then((res) => setMe(res.user))
      .catch(() => {});
  }, []);

  return (
    <>
      {/* `hideMobile` — Crew chat's own composer sits flush to the bottom of the mobile
          viewport (the same full-screen-conversation layout WhatsApp/iMessage use); the
          floating nav pill has nowhere to sit there without overlapping it. A back arrow at
          the top of Crew already gets you out, so losing the tab bar for the duration of one
          conversation costs nothing. Desktop is unaffected — the rail lives in its own fixed
          column the composer never extends into. */}
      <nav className="v2-nav-bottom" style={hideMobile ? { display: 'none' } : undefined}>
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} className={`v2-tab ${active ? 'active' : ''}`} aria-label={tab.label}>
              {tab.icon}
              <span className="v2-dot" />
            </Link>
          );
        })}
      </nav>
      <nav className="v2-nav-rail">
        {/* Real, reported feedback: this was a plain letter in a box, reading as an unfinished
            app-icon placeholder, not a logo. Replaced with an actual mark — the same
            three-rays-converging-to-a-point geometry as IconLock (components/icons.tsx), Plot's
            own established "committed" mark, reused here at a larger scale as the wordmark
            itself: a Crew's scattered options resolving into one point IS what Plot does, so the
            logo is that idea, not a letterform. Rendered in --v2-pop (the one accent colour
            already used for emphasis elsewhere — "Will" in Home's greeting, notification badges)
            so it reads as a deliberate brand mark, not another neutral icon. */}
        <div className="v2-rail-mark" aria-label="Plot">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--v2-pop)" strokeWidth="2" strokeLinecap="round">
            <circle cx="10" cy="10.5" r="2.6" fill="var(--v2-pop)" stroke="none" />
            <path d="M10 6.3V3.2" />
            <path d="M13.6 12.6 16.3 14.15" />
            <path d="M6.4 12.6 3.7 14.15" />
          </svg>
        </div>
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} className={`v2-tab ${active ? 'active' : ''}`} aria-label={tab.label} title={tab.label}>
              {tab.icon}
            </Link>
          );
        })}
        <div className="v2-rail-spacer" />
        <Link href="/profile" className="v2-rail-avatar" aria-label="Your profile" title="Your profile">
          {(me ? displayNameOf(me.displayName, me.email) : '·').charAt(0).toUpperCase()}
        </Link>
      </nav>
    </>
  );
}
