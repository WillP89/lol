import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/apiServer';
import { v2Art } from '@/lib/v2Art';
import { formatPriceRange } from '@/lib/formatPrice';
import { VoteForm } from './VoteForm';

interface PlanCardResponse {
  plan: {
    id: string;
    title: string;
    status: string;
    crew: { id: string; name: string };
    // Real, reported bug this closes: `imageUrl`/`description`/`priceMaxMinor`/`currency` were
    // never declared here even though the API's own `getPlanBySlug` (services/plan.ts) already
    // `include`s the full Experience row and sends it through untouched — this type just never
    // asked for the rest of it, so a real Skiddle/Ticketmaster photo (confirmed present on this
    // exact experience elsewhere in the app) silently never reached this page. `externalUrl`
    // itself lives on ProviderListing, not Experience (a canonical Experience is provider-
    // agnostic — see entityResolution.ts) — `getPlanBySlug` now reaches into the most-recently-
    // refreshed one for exactly this page's use.
    experience: {
      name: string;
      category: string;
      venue: { name: string; city: string } | null;
      startsAt: string;
      priceMinMinor: number | null;
      priceMaxMinor: number | null;
      currency: string;
      imageUrl: string | null;
      description: string;
      listings: { externalUrl: string }[];
    } | null;
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

  const priceLabel = plan.experience
    ? formatPriceRange(plan.experience.priceMinMinor, plan.experience.priceMaxMinor, plan.experience.currency)
    : null;

  return (
    <div className="v2">
      <div className="v2-page" style={{ paddingTop: 0, paddingBottom: 40, maxWidth: 480 }}>
        {/* Real, reported feedback: "the worst feeling part of the app" — a 150px strip of
            generic category art (and, until the type fix above, not even that: a hardcoded
            `null` meant a REAL Skiddle/Ticketmaster photo for this exact experience never showed
            here even when the app had it, confirmed elsewhere in the product). This is now a
            real hero — genuinely large, the actual photo when the experience has one — with a
            back way out (there wasn't one at all before) and the same frosted-glass caption
            treatment already shipped for Explore's own cards, so a plan shared as a link opens
            to something that looks like the rest of the product, not a stripped-down fallback
            of it. */}
        <div style={{ position: 'relative', height: 260, margin: '0 -20px 22px', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, background: v2Art(plan.experience?.imageUrl, plan.experience?.category) }} />
          <div
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, height: '58%',
              backdropFilter: 'blur(14px) saturate(115%)', WebkitBackdropFilter: 'blur(14px) saturate(115%)',
              maskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 30%, #000 62%)',
              WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 30%, #000 62%)',
            }}
          />
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '58%', background: 'linear-gradient(180deg, rgba(17,14,11,0) 0%, rgba(17,14,11,0.42) 46%, rgba(14,11,9,0.93) 100%)' }} />
          {/* Only a real destination once one exists — an authenticated visitor (almost always
              someone already in this Crew) goes back to the conversation; an anonymous share-
              link visitor (the actual common case this page is built for) has nowhere real to
              "go back" to, so no dead-end arrow is shown for them either. */}
          {isAuthenticated && (
            <Link
              href={`/crews/${plan.crew.id}`}
              aria-label={`Back to ${plan.crew.name}`}
              style={{
                position: 'absolute', top: 16, left: 16, width: 34, height: 34, borderRadius: '50%',
                background: 'rgba(20,17,14,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 18, textDecoration: 'none',
              }}
            >
              ←
            </Link>
          )}
          {priceLabel && (
            <span style={{ position: 'absolute', top: 16, right: 16, fontSize: 12.5, fontWeight: 800, color: '#fff', background: 'rgba(20,17,14,0.55)', backdropFilter: 'blur(6px)', padding: '7px 13px', borderRadius: 100 }}>
              {priceLabel}
            </span>
          )}
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 16 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: 'rgba(255,255,255,0.75)', marginBottom: 4 }}>{plan.crew.name}</div>
            <h1 className="v2-display" style={{ fontSize: 26, lineHeight: 1.05, color: '#fff' }}>{plan.title}</h1>
          </div>
        </div>

        {(plan.experience || plan.manualVenueName || plan.manualStartsAt) && (
          <p className="v2-muted" style={{ marginBottom: 14, fontSize: 14 }}>
            {plan.experience ? (
              <>
                {new Date(plan.experience.startsAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                {plan.experience.venue && ` · ${plan.experience.venue.name}, ${plan.experience.venue.city}`}
              </>
            ) : (
              <>
                {plan.manualStartsAt && new Date(plan.manualStartsAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                {plan.manualVenueName && `${plan.manualStartsAt ? ' · ' : ''}${plan.manualVenueName}`}
              </>
            )}
          </p>
        )}

        {/* Real event detail, not just a date and a vote form — the actual description the
            provider gave us, passed through unmodified (Skiddle/Ticketmaster's own terms
            require exactly that), and a genuine "view it at the source" link so someone can
            check exact pricing tiers, age restrictions, seating, whatever the provider's own
            page has that a Plan Card was never going to duplicate — rather than pretending this
            page is the whole story. */}
        {plan.experience?.description && (
          <p style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 16, color: 'var(--v2-ink)' }}>{plan.experience.description}</p>
        )}
        {plan.experience?.listings[0]?.externalUrl && (
          <a
            href={plan.experience.listings[0].externalUrl}
            target="_blank"
            rel="noreferrer"
            className="v2-btn v2-btn-ghost"
            style={{ width: '100%', marginBottom: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            View full details & pricing ↗
          </a>
        )}

        <VoteForm slug={params.slug} initialPulse={pulse} isAuthenticated={isAuthenticated} crewId={plan.crew.id} crewName={plan.crew.name} />
      </div>
    </div>
  );
}
