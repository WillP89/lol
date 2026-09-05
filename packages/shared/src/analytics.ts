/**
 * Plot analytics event taxonomy.
 *
 * Design principle (see docs/ARCHITECTURE.md §Analytics): every event exists to answer a
 * specific product question about the MATCH → AGREE → LOCK loop. We do not log everything
 * that moves; we log the funnel we actually need to instrument the pilot's success criteria
 * (see docs/PILOT.md). Adding an event to this file is a deliberate product decision, not a
 * side effect of instrumenting a click handler.
 *
 * This file is the single source of truth for event names and payload shapes. Both the API
 * (which persists events to IntentSignal/AnalyticsEvent) and the web app (which fires them)
 * import from here, so client and server can never drift out of sync.
 */

export const AnalyticsEvents = {
  // Acquisition / onboarding funnel
  SignupStarted: 'SignupStarted',
  SignupCompleted: 'SignupCompleted',
  TasteStarted: 'TasteStarted',
  TasteCompleted: 'TasteCompleted',
  // The personalisation-engine pass — specific-interest taps and free-text signals in the
  // "Tune My Plot" editor, distinct from TasteCompleted's one-time bulk onboarding write.
  TasteInterestUpdated: 'TasteInterestUpdated',
  TasteFreeTextAdded: 'TasteFreeTextAdded',
  AiTasteSetupApplied: 'AiTasteSetupApplied',
  CrewAiTasteSetupApplied: 'CrewAiTasteSetupApplied',
  CalendarPrompted: 'CalendarPrompted',
  CalendarConnected: 'CalendarConnected',
  CalendarSkipped: 'CalendarSkipped',
  ContactsPrompted: 'ContactsPrompted',
  ContactsConnected: 'ContactsConnected',
  ContactsSkipped: 'ContactsSkipped',

  // Crew lifecycle
  CrewCreated: 'CrewCreated',
  CrewInviteSent: 'CrewInviteSent',
  // The invite-preview moment (before auth) and the moment it actually converts into
  // membership — two different funnel steps with a real drop-off between them, worth telling
  // apart from CrewJoined (which fires for any join, invite or not).
  InviteOpened: 'InviteOpened',
  InviteAccepted: 'InviteAccepted',
  CrewJoined: 'CrewJoined',
  CrewLeft: 'CrewLeft',
  CrewMemberRemoved: 'CrewMemberRemoved',
  CrewMessageSent: 'CrewMessageSent',
  // The email half of the message-notification digest (services/messageNotifications.ts) —
  // distinct from CrewMessageSent (an in-app action) since this is Plot itself sending
  // something, on its own debounced schedule, worth being able to see in the funnel separately
  // (e.g. "is the sweep actually running / reaching anyone").
  CrewMessageDigestEmailSent: 'CrewMessageDigestEmailSent',
  ReactionAdded: 'ReactionAdded',
  PollCreated: 'PollCreated',
  PollVoted: 'PollVoted',
  AvailabilitySubmitted: 'AvailabilitySubmitted',

  // Match (Discover -> Match)
  FindUsSomethingOpened: 'FindUsSomethingOpened',
  RecommendationShown: 'RecommendationShown',
  RecommendationOpened: 'RecommendationOpened',
  RecommendationDismissed: 'RecommendationDismissed',
  SuggestionsSentToChat: 'SuggestionsSentToChat',
  ItemViewed: 'ItemViewed',
  ItemSharedToCrew: 'ItemSharedToCrew',
  // The automatic Crew recommendation system (docs/DECISIONS.md#crew-auto-recommendations) —
  // distinct from RecommendationShown/Dismissed above, which are about the manual "Find us
  // something" flow's own PlanRecommendation model. These are unprompted deliveries.
  CrewRecommendationDelivered: 'CrewRecommendationDelivered',
  CrewRecommendationResponded: 'CrewRecommendationResponded',

  // Agree (Plan / consensus)
  SentToCrew: 'SentToCrew',
  PlanCardViewed: 'PlanCardViewed',
  PlanCardOpenedExternal: 'PlanCardOpenedExternal',
  VoteSubmitted: 'VoteSubmitted',
  PlanPulseChanged: 'PlanPulseChanged',
  PlanReady: 'PlanReady',

  // Lock (booking)
  BookingStarted: 'BookingStarted',
  BookingCompleted: 'BookingCompleted',
  BookingFailed: 'BookingFailed',

  // Post-plan
  PlanCompleted: 'PlanCompleted',
  // The moment consensus becomes commitment — "Saturday's looking good" turning into "Lock it
  // in" — distinct from PlanReady (which just means the threshold was crossed automatically).
  PlanLocked: 'PlanLocked',
  CalendarAdded: 'CalendarAdded',
  RewindSubmitted: 'RewindSubmitted',
  CrewSecondPlan: 'CrewSecondPlan',

  // Feedback / trust
  FeedbackSubmitted: 'FeedbackSubmitted',

  // HOME = ME (docs/DECISIONS.md#personal-home) — the individual-facing personalisation surface,
  // distinct from RecommendationShown/CrewRecommendationDelivered above (both Crew-facing). Lets
  // Part 23's own metrics ("irrelevant impression rate", category/source diversity) actually be
  // computed later, and — combined with the real Stage-A eligibility gate these events sit
  // behind — gives a real, queryable trail of what a person's Home actually showed and did with
  // it, not just what the manual Crew-recommendation funnel did.
  HomePersonalizedImpression: 'HomePersonalizedImpression',
  HomeItemFeedback: 'HomeItemFeedback',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

export interface AnalyticsEventPayloads {
  SignupStarted: { method: 'email' | 'apple' | 'google' };
  SignupCompleted: { userId: string; method: 'email' | 'apple' | 'google' };
  TasteStarted: { userId: string };
  TasteCompleted: { userId: string; cardsShown: number; yes: number; maybe: number; no: number };
  TasteInterestUpdated: { userId: string; count: number };
  TasteFreeTextAdded: { userId: string; matched: boolean };
  AiTasteSetupApplied: { userId: string; interestCount: number; freeTextCount: number };
  CrewAiTasteSetupApplied: { crewId: string; userId: string; interestCount: number };
  CalendarPrompted: { userId: string };
  CalendarConnected: { userId: string; provider: 'google' | 'apple' | 'microsoft' };
  CalendarSkipped: { userId: string };
  ContactsPrompted: { userId: string };
  ContactsConnected: { userId: string; matchedCount: number };
  ContactsSkipped: { userId: string };

  CrewCreated: { crewId: string; userId: string; memberCount: number };
  CrewInviteSent: { crewId: string; channel: 'link' | 'whatsapp' | 'imessage' | 'sms' | 'other' | 'email' };
  InviteOpened: { inviteCode: string; authenticated: boolean };
  InviteAccepted: { crewId: string; userId: string };
  CrewJoined: { crewId: string; userId: string; viaInvite: boolean };
  CrewLeft: { crewId: string; userId: string };
  CrewMemberRemoved: { crewId: string; removedUserId: string; userId: string };
  CrewMessageSent: { crewId: string; userId: string };
  CrewMessageDigestEmailSent: { crewId: string; userId: string; messageCount: number };
  ReactionAdded: { crewId: string; messageId: string; emoji: string; userId: string };
  PollCreated: { crewId: string; messageId: string; kind: 'GENERAL' | 'AVAILABILITY'; optionCount: number };
  PollVoted: { crewId: string; messageId: string; option: string };
  AvailabilitySubmitted: { crewId: string; userId: string };

  FindUsSomethingOpened: { crewId: string; userId: string };
  RecommendationShown: { crewId: string; planRecommendationId: string; optionCount: number };
  RecommendationOpened: { crewId: string; planRecommendationId: string; optionId: string };
  RecommendationDismissed: { crewId: string; planRecommendationId: string; reason?: string };
  // The core-loop action: "find something" and post it straight into the Crew's chat in one
  // tap, rather than reviewing options on a separate results screen first.
  SuggestionsSentToChat: { crewId: string; count: number };
  ItemViewed: { experienceId: string; source: 'explore' | 'home' | 'chat' };
  ItemSharedToCrew: { crewId: string; experienceId: string };
  CrewRecommendationDelivered: { crewId: string; experienceId: string; score: number };
  CrewRecommendationResponded: {
    crewId: string;
    recommendationId: string;
    action: 'more_like_this' | 'not_for_us' | 'too_far' | 'too_expensive' | 'wrong_vibe';
    userId: string;
  };

  SentToCrew: { crewId: string; planId: string; source: 'find_us_something' | 'individual_send' | 'recommendation' };
  PlanCardViewed: { planId: string; viewerUserId?: string; authenticated: boolean };
  PlanCardOpenedExternal: { planId: string; referrer?: string };
  VoteSubmitted: { planId: string; userId: string; vote: 'in' | 'maybe' | 'out' };
  PlanPulseChanged: { planId: string; pulseLevel: number; status: string };
  PlanReady: { planId: string; crewId: string };

  BookingStarted: { planId: string; userId: string; model: 'deep_link' | 'affiliate' | 'api' | 'native' };
  BookingCompleted: { planId: string; bookingId: string; participantCount: number; amountMinor: number; currency: string };
  BookingFailed: { planId: string; reason: string };

  PlanCompleted: { planId: string; crewId: string };
  PlanLocked: { planId: string; crewId: string; userId: string };
  CalendarAdded: { planId: string; userId?: string };
  RewindSubmitted: { planId: string; crewId: string; userId: string; rating: 'love' | 'like' | 'meh' | 'no' };
  CrewSecondPlan: { crewId: string; daysSinceFirstPlan: number };

  FeedbackSubmitted: { context: string; category: string; userId?: string };

  HomePersonalizedImpression: {
    personalized: boolean;
    forYouCount: number;
    thisWeekendCount: number;
    interestRowCount: number;
    nearYouCount: number;
    explorationCount: number;
  };
  HomeItemFeedback: { experienceId: string; action: 'save' | 'not_for_me' | 'pass' | 'view' };
}

export type AnalyticsEvent<K extends AnalyticsEventName = AnalyticsEventName> = {
  name: K;
  payload: AnalyticsEventPayloads[K];
  occurredAt: string;
  anonymousId?: string;
};
