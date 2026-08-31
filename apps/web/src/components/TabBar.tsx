'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { displayNameOf } from '@/lib/displayName';

/**
 * The app's primary navigation — a bottom bar on mobile, a left sidebar on desktop (same
 * markup, see the `.tabbar`/`.tab` media queries in globals.css; no separate desktop
 * component to keep in sync). Five real destinations, each answering a question a person
 * actually has, not a database entity:
 *   Home    — "what are my people up to?"          (the social heartbeat)
 *   Explore — "what's happening I don't know about?" (discovery)
 *   Crews   — "who am I planning with?"              (the groups themselves)
 *   Plans   — "what's actually locked in?"           (confirmed, not buried in chat)
 *   You     — identity, taste, account
 * Deliberately absent from immersive/full-height screens (chat, the match results flow,
 * onboarding mid-wizard, auth, the public Plan Card/booking pages reached from a shared link)
 * where it would either fight the keyboard for space or not make sense as "a tab" to land
 * back on.
 */
const TABS = [
  {
    href: '/home',
    label: 'Home',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <path d="M4 11.5 12 4l8 7.5M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
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
    href: '/crews',
    label: 'Crews',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <path d="M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-3 2.5-5 5-5s5 2 5 5" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/plans',
    label: 'Plans',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <rect x="4" y="5" width="16" height="15" rx="2.5" stroke="currentColor" fill="none" strokeWidth="1.75" />
        <path d="M8 3v4M16 3v4M4 10h16" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" />
        <path d="m9 14.5 2 2 4-4.5" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: '/profile',
    label: 'You',
    icon: (active: boolean) => (
      <svg className="icon" viewBox="0 0 24 24" width="21" height="21" style={{ color: active ? 'var(--ink-gold)' : 'var(--ink-text-muted)' }}>
        <circle cx="12" cy="8" r="3.5" stroke="currentColor" fill="none" strokeWidth="1.75" />
        <path d="M4.5 20c0-3.5 3.5-6 7.5-6s7.5 2.5 7.5 6" stroke="currentColor" fill="none" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function TabBar({ desktopOnly }: { desktopOnly?: boolean } = {}) {
  const pathname = usePathname();
  // Desktop-only footer identity (see `.tabbar-account` in globals.css, hidden below 900px) —
  // a bare stack of links read as an admin tool's nav rail exactly because it had no anchor at
  // either end. A pinned account row at the bottom is the detail every real product sidebar
  // (Slack, Discord, Linear, Spotify) has that a generic one doesn't.
  const [me, setMe] = useState<{ displayName: string | null; email: string } | null>(null);
  useEffect(() => {
    api
      .get<{ user: { displayName: string | null; email: string } }>('/users/me')
      .then((res) => setMe(res.user))
      .catch(() => {});
  }, []);

  // Chat needs its full-height keyboard-safe layout on mobile — a floating pill nav fixed to
  // the same bottom edge as the composer would sit on top of it. Desktop has no such
  // constraint and, unlike every other screen, was left with no persistent nav at all once
  // Crew+Chat merged into one full-height view — this renders the sidebar there without
  // reintroducing the mobile collision.
  return (
    <nav className={`tabbar ${desktopOnly ? 'tabbar-desktop-only' : ''}`}>
      <div className="tabbar-brand">
        Plot<span>·</span>
      </div>
      {TABS.map((tab) => {
        // /crews/[id] and its sub-routes still count as the Crews tab being "home".
        const active = pathname.startsWith(tab.href);
        return (
          <Link key={tab.href} href={tab.href} className={`tab ${active ? 'active' : ''}`}>
            <span className="tab-icon">{tab.icon(active)}</span>
            <span>{tab.label}</span>
          </Link>
        );
      })}
      <div className="tabbar-spacer" />
      <Link href="/profile" className="tabbar-account">
        <div className="avatar" style={{ background: 'var(--ink-gold)', width: 30, height: 30, fontSize: 12 }}>
          {(me ? displayNameOf(me.displayName, me.email) : '·').charAt(0).toUpperCase()}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {me ? displayNameOf(me.displayName, me.email) : 'Loading…'}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>View profile</div>
        </div>
      </Link>
    </nav>
  );
}
