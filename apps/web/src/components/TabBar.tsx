'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The demo's defining piece of chrome (`.tabbar`, phone-shell bottom nav) that the real app
 * never had — only a thin top nav with a couple of text links. Persistent across the app's
 * three top-level destinations; deliberately absent from immersive/full-height screens (chat,
 * the match results flow, onboarding mid-wizard, auth, the public Plan Card/booking pages
 * reached from a shared link) where it would either fight for vertical space against a
 * keyboard or not make sense as "a tab" to land back on.
 */
const TABS = [
  {
    href: '/crews',
    label: 'Crews',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <path d="M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-3 2.5-5 5-5s5 2 5 5" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/explore',
    label: 'Explore',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <path d="M12 2C7 2 4 5.5 4 10c0 6 8 12 8 12s8-6 8-12c0-4.5-3-8-8-8Z" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="10" r="2.5" stroke="currentColor" fill="none" strokeWidth="1.75" />
      </svg>
    ),
  },
  {
    href: '/profile',
    label: 'Profile',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <circle cx="12" cy="8" r="3.5" stroke="currentColor" fill="none" strokeWidth="1.75" />
        <path d="M4.5 20c0-3.5 3.5-6 7.5-6s7.5 2.5 7.5 6" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="tabbar">
      {TABS.map((tab) => {
        // /crews/[id] and its sub-routes still count as the Crews tab being "home".
        const active = tab.href === '/crews' ? pathname.startsWith('/crews') : pathname.startsWith(tab.href);
        return (
          <Link key={tab.href} href={tab.href} className={`tab ${active ? 'active' : ''}`}>
            {tab.icon(active)}
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
