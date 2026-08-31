// Matches the exact shape services/plan.ts posts when a Plan is sent to a Crew — see
// createPlanForCrew's chat announcement. Chat itself parses this into a real event card; every
// other surface that shows a "latest message" preview (Home's activity feed, a Crew tile) just
// needs the human part, not the raw internal `— /plans/slug` suffix that's only meaningful to
// chat's own link-detection.
const PLAN_ANNOUNCEMENT = /^📍 Sent "(.+)" to the Crew — \/plans\/[a-zA-Z0-9-]+$/;

export function messagePreview(body: string): string {
  const match = body.match(PLAN_ANNOUNCEMENT);
  return match ? `📍 Sent "${match[1]}" to the Crew` : body;
}
