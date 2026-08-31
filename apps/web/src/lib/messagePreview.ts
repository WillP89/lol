// Matches the two shapes services/plan.ts posts when a Plan lands in a Crew — a member's own
// share, or the automatic recommendation engine's distinct copy (see docs/DECISIONS.md#crew-
// auto-recommendations). Chat itself parses either into a real event card; every other surface
// that shows a "latest message" preview (Home's activity feed, a Crew tile) just needs the
// human part, not the raw internal `— /plans/slug` suffix that's only meaningful to chat's own
// link-detection — and no emoji standing in for iconography in plain preview text.
const MEMBER_PLAN_ANNOUNCEMENT = /^📍 Sent "(.+)" to the Crew — \/plans\/[a-zA-Z0-9-]+$/;
const RECOMMENDATION_PLAN_ANNOUNCEMENT = /^✨ Plot found something your Crew might like: "(.+)" — \/plans\/[a-zA-Z0-9-]+$/;

export function messagePreview(body: string): string {
  const memberMatch = body.match(MEMBER_PLAN_ANNOUNCEMENT);
  if (memberMatch) return `Sent "${memberMatch[1]}" to the Crew`;
  const recMatch = body.match(RECOMMENDATION_PLAN_ANNOUNCEMENT);
  if (recMatch) return `Plot found "${recMatch[1]}"`;
  return body;
}
