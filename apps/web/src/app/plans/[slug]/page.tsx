import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { apiFetchServer } from '@/lib/apiServer';
import { v2Art } from '@/lib/v2Art';
import { formatPriceFrom } from '@/lib/formatPrice';
import { VoteForm } from './VoteForm';

interface PlanCardResponse {
  plan: {
    id: string;
    title: string;
    status: string;
    crew: { name: string };
    experience: { name: string; category: string; venue: { name: string; city: string } | null; startsAt: string; priceMinMinor: number | null } | null;
    // A Plan with no Experience at all ("Pub Saturday", a poll locked straight to a Plan) still
    // has somewhere and (optionally) somewhen — see docs/DECISIONS.md#manual-plans.
    manualVenueName: string | null;
    manualStartsAt: string | null;
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
  const when = plan.experience?.startsAt ?? plan.manualStartsAt;
  const where = plan.experience?.venue?.name ?? plan.manualVenueName;
  const description = when
    ? `${new Date(when).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${
        where ? ` · ${where}` : ''
      } · ${pulse.inCount}/${pulse.totalMembers} are in. Are you?`
    : where
      ? `${where} · ${pulse.inCount}/${pulse.totalMembers} are in. Are you?`
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

  return (
    <div className="v2">
      <div className="v2-page" style={{ paddingTop: 0, paddingBottom: 40, maxWidth: 480 }}>
        <div style={{ height: 150, margin: '0 -20px 22px', background: v2Art(null, plan.experience?.category) }} />

        <div className="v2-eyebrow">{plan.crew.name}</div>
        <h1 className="v2-display" style={{ fontSize: 27, marginBottom: 8 }}>{plan.title}</h1>

        {(plan.experience || plan.manualVenueName || plan.manualStartsAt) && (
          <p className="v2-muted" style={{ marginBottom: 22, fontSize: 14 }}>
            {plan.experience ? (
              <>
                {new Date(plan.experience.startsAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                {plan.experience.venue && ` · ${plan.experience.venue.name}, ${plan.experience.venue.city}`}
                {formatPriceFrom(plan.experience.priceMinMinor) && ` · ${formatPriceFrom(plan.experience.priceMinMinor)}`}
              </>
            ) : (
              <>
                {plan.manualStartsAt && new Date(plan.manualStartsAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                {plan.manualVenueName && `${plan.manualStartsAt ? ' · ' : ''}${plan.manualVenueName}`}
              </>
            )}
          </p>
        )}

        <VoteForm slug={params.slug} initialPulse={pulse} isAuthenticated={isAuthenticated} />
      </div>
    </div>
  );
}
