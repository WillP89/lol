// Matches the two shapes services/plan.ts posts when a Plan lands in a Crew — a member's own
// share, or the automatic recommendation engine's distinct copy (see docs/DECISIONS.md#crew-
// auto-recommendations). Chat itself parses either into a real event card; every other surface
// that shows a "latest message" preview (Home's activity feed, a Crew tile) just needs the
// human part, not the raw internal `— /plans/slug` suffix that's only meaningful to chat's own
// link-detection — and no emoji standing in for iconography in plain preview text.
//
// The recommendation lead-in is deliberately NOT anchored to one fixed phrase any more —
// services/plan.ts#createRecommendationPlanForCrew now sends a different, honest lead-in
// ("There's not much in your area right now, so how about this") whenever it had to fall back
// to a non-ticketed candidate (see docs/DECISIONS.md#crew-recommendation-architecture). Real bug
// this generalisation fixes: the old fixed-phrase regex stopped matching that fallback message
// entirely, so it rendered as a bare text bubble instead of the real event card — exactly the
// "format drift" failure mode this file's own comment already warns about, just for a lead-in
// change instead of a whole new format. Still requires the exact `: "..." — /plans/<slug>`
// shape, which the member-share format never produces (no colon before its own quoted title),
// so this can't collide with `MEMBER_PLAN_ANNOUNCEMENT` above.
const MEMBER_PLAN_ANNOUNCEMENT = /^Sent "(.+)" to the Crew — \/plans\/[a-zA-Z0-9-]+$/;
const RECOMMENDATION_PLAN_ANNOUNCEMENT = /^.+: "(.+)" — \/plans\/[a-zA-Z0-9-]+$/;

export function messagePreview(body: string): string {
  const memberMatch = body.match(MEMBER_PLAN_ANNOUNCEMENT);
  if (memberMatch) return `Sent "${memberMatch[1]}" to the Crew`;
  const recMatch = body.match(RECOMMENDATION_PLAN_ANNOUNCEMENT);
  if (recMatch) return `Plot found "${recMatch[1]}"`;
  return body;
}
