import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { apiFetchServer } from '@/lib/apiServer';
import { categoryStyle } from '@/lib/categoryStyle';
import { formatPriceFrom } from '@/lib/formatPrice';
import { VoteForm } from './VoteForm';

interface PlanCardResponse {
  plan: {
    id: string;
    title: string;
    status: string;
    crew: { name: string };
    experience: { name: string; category: string; venue: { name: string; city: string } | null; startsAt: string; priceMinMinor: number | null } | null;
  };
  pulse: { inCount: number; maybeCount: number; outCount: number; totalMembers: number; level: number; status: string };
}

async function loadPlan(slug: string): Promise<PlanCardResponse | null> {
  const { status, body } = await apiFetchServer<PlanCardResponse>(`/plans/public/${slug}`);
  if (status === 404) return null;
  return body;
}

/**
 * Server-rendered deliberately (brief §16): this is the page that gets shared into WhatsApp/
 * iMessage as a Plan Card. Real OpenGraph metadata means the rich preview WhatsApp renders is
 * the plan itself, not a generic "Plot" card — that preview IS the growth mechanic.
 */
export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const data = await loadPlan(params.slug);
  if (!data) return { title: 'Plan not found — Plot' };

  const { plan, pulse } = data;
  const title = `${plan.title} — ${plan.crew.name} on Plot`;
  const description = plan.experience
    ? `${new Date(plan.experience.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${
        plan.experience.venue ? ` · ${plan.experience.venue.name}` : ''
      } · ${pulse.inCount}/${pulse.totalMembers} are in. Are you?`
    : `${plan.crew.name} are deciding. Are you in?`;

  return {
    title,
    description,
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function PlanCardPage({ params }: { params: { slug: string } }) {
  const data = await loadPlan(params.slug);
  if (!data) notFound();

  const { plan, pulse } = data;
  const isAuthenticated = Boolean(cookies().get('plot_session'));
  const style = categoryStyle(plan.experience?.category);

  return (
    <div className="page" style={{ paddingTop: 0, maxWidth: 480 }}>
      <div className="art-block" style={{ background: style.bg, height: 96, fontSize: 34, borderRadius: 0, margin: '0 -20px 20px' }}>
        {style.emoji}
      </div>

      <div className="eyebrow">{plan.crew.name}</div>
      <h1 style={{ fontSize: 26, marginBottom: 8 }}>{plan.title}</h1>

      {plan.experience && (
        <p className="muted" style={{ marginBottom: 20 }}>
          {new Date(plan.experience.startsAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
          {plan.experience.venue && ` · ${plan.experience.venue.name}, ${plan.experience.venue.city}`}
          {formatPriceFrom(plan.experience.priceMinMinor) && ` · ${formatPriceFrom(plan.experience.priceMinMinor)}`}
        </p>
      )}

      <VoteForm slug={params.slug} initialPulse={pulse} isAuthenticated={isAuthenticated} />
    </div>
  );
}
