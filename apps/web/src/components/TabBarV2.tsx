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
    label: 'Explore',
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

export function TabBarV2() {
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
      <nav className="v2-nav-bottom">
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
        <div className="v2-rail-mark">P</div>
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
