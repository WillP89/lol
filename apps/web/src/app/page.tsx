import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import LandingClient from './LandingClient';

/**
 * The entrance — kept as a server component specifically so the signed-in redirect stays
 * server-side (checked before any HTML ships, no client-side flash of the pitch page to someone
 * already signed in) even though the page's actual content needs client hooks (scroll-reveal,
 * the mock life-cycle card's timer) — those live in LandingClient, rendered below.
 */
export default function LandingPage() {
  if (cookies().get('plot_session')) {
    redirect('/home');
  }
  return <LandingClient />;
}
