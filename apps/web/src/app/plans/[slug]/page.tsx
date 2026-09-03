import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/apiServer';
import { v2Art } from '@/lib/v2Art';
import { formatPriceRange } from '@/lib/formatPrice';
import { identityPair } from '@/lib/identity';
import { IconCalendar, IconPlace } from '@/components/icons';
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
  const categoryLabel = plan.experience?.category?.replace(/_/g, ' ');
  const [, categoryAccent] = identityPair(plan.experience?.category ?? plan.title);
  const when = plan.experience?.startsAt ?? plan.manualStartsAt;
  const where = plan.experience ? plan.experience.venue && `${plan.experience.venue.name}, ${plan.experience.venue.city}` : plan.manualVenueName;

  return (
    <div className="v2">
      {/* Real, repeated feedback: "the most basic, under-invested part of the app... feel more
          immersive, not just like a form." The fix isn't a bigger photo alone (that shipped
          already) — it's the whole composition: everything below the hero used to just continue
          flat down the page background, the exact "settings form" feeling being complained
          about. A card now overlaps the hero by a real amount (the negative margin below), the
          same layered-surface language Explore's detail sheet and Profile's cards already use
          elsewhere in the product — so this reads as one designed object, not a photo banner
          with a form bolted underneath it. */}
      <div className="v2-page" style={{ paddingTop: 0, paddingBottom: 40, maxWidth: 480 }}>
        <div style={{ position: 'relative', height: 340, margin: '0 -20px', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, background: v2Art(plan.experience?.imageUrl, plan.experience?.category, plan.id) }} />
          <div
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%',
              backdropFilter: 'blur(14px) saturate(115%)', WebkitBackdropFilter: 'blur(14px) saturate(115%)',
              maskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 26%, #000 60%)',
              WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 26%, #000 60%)',
            }}
          />
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%', background: 'linear-gradient(180deg, rgba(17,14,11,0) 0%, rgba(17,14,11,0.4) 42%, rgba(14,11,9,0.96) 100%)' }} />
          {/* Only a real destination once one exists — an authenticated visitor (almost always
              someone already in this Crew) goes back to the conversation; an anonymous share-
              link visitor (the actual common case this page is built for) has nowhere real to
              "go back" to, so no dead-end arrow is shown for them either. */}
          {isAuthenticated && (
            <Link
              href={`/crews/${plan.crew.id}`}
              aria-label={`Back to ${plan.crew.name}`}
              style={{
                position: 'absolute', top: 16, left: 16, width: 36, height: 36, borderRadius: '50%',
                background: 'rgba(20,17,14,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 18, textDecoration: 'none',
              }}
            >
              ←
            </Link>
          )}
          {priceLabel && (
            <span style={{ position: 'absolute', top: 17, right: 20, fontSize: 12.5, fontWeight: 800, color: '#fff', background: 'rgba(20,17,14,0.55)', backdropFilter: 'blur(6px)', padding: '7px 13px', borderRadius: 100 }}>
              {priceLabel}
            </span>
          )}
          <div style={{ position: 'absolute', left: 22, right: 22, bottom: 40 }}>
            {categoryLabel && (
              <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase', color: '#fff', background: categoryAccent, padding: '5px 11px', borderRadius: 100, marginBottom: 10 }}>
                {categoryLabel}
              </span>
            )}
            <div style={{ fontSize: 12, fontWeight: 800, color: 'rgba(255,255,255,0.8)', marginBottom: 5 }}>{plan.crew.name}</div>
            <h1 className="v2-display" style={{ fontSize: 27, lineHeight: 1.08, color: '#fff' }}>{plan.title}</h1>
          </div>
        </div>

        {/* The card itself — pulled up over the hero's bottom edge so the two read as one
            layered object, not a banner-then-page-content stack. */}
        <div className="v2-card" style={{ position: 'relative', margin: '-22px -20px 0', borderRadius: '22px 22px 0 0', padding: '22px 20px 24px', boxShadow: '0 -8px 24px rgba(20,14,8,0.08)' }}>
          {(when || where) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
              {when && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--v2-bg-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--v2-ink-muted)' }}>
                    <IconCalendar size={16} />
                  </span>
                  <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                    {new Date(when).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}
              {where && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--v2-bg-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--v2-ink-muted)' }}>
                    <IconPlace size={16} />
                  </span>
                  <span style={{ fontSize: 14.5, fontWeight: 600 }}>{where}</span>
                </div>
              )}
            </div>
          )}

          {/* Real event detail, not just a date and a vote form — the actual description the
              provider gave us, passed through unmodified (Skiddle/Ticketmaster's own terms
              require exactly that), and a genuine "view it at the source" link so someone can
              check exact pricing tiers, age restrictions, seating, whatever the provider's own
              page has that a Plan Card was never going to duplicate — rather than pretending this
              page is the whole story. */}
          {plan.experience?.description && (
            <>
              <div className="v2-eyebrow" style={{ marginBottom: 6 }}>About this plan</div>
              <p style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 16, color: 'var(--v2-ink-muted)' }}>{plan.experience.description}</p>
            </>
          )}
          {plan.experience?.listings[0]?.externalUrl && (
            <a
              href={plan.experience.listings[0].externalUrl}
              target="_blank"
              rel="noreferrer"
              className="v2-btn v2-btn-ghost v2-tap-feedback"
              style={{ width: '100%', marginBottom: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              View full details & pricing ↗
            </a>
          )}

          <div style={{ height: 1, background: 'var(--v2-line)', margin: '4px 0 20px' }} />

          <VoteForm slug={params.slug} initialPulse={pulse} isAuthenticated={isAuthenticated} crewId={plan.crew.id} crewName={plan.crew.name} />
        </div>
      </div>
    </div>
  );
}
