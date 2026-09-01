/**
 * Plot's own icon set — one coherent line-icon language (20px viewBox, 1.75 stroke, round caps
 * and joins throughout) replacing the generic system emoji that used to stand in for product
 * concepts (idea, place, poll, availability, plan, lock, chat, map). This is the direct fix for
 * the pilot brief's "REMOVE ALL GENERIC SYSTEM EMOJI FROM PRODUCT UI" requirement — every icon
 * here is purpose-drawn for what it represents in Plot's own loop, not a random icon-library
 * swap. Emoji a user types inside their own chat message is untouched; the REACTION_CHOICES
 * palette (crews/[id]/page.tsx) stays emoji too, since those glyphs ARE the reaction feature
 * itself, not iconography standing in for something else. See docs/DECISIONS.md#plot-iconography.
 *
 * Every icon takes the same `size`/`color`/`strokeWidth` props and defaults to `currentColor`,
 * so it inherits whatever text colour surrounds it — no icon here hardcodes its own colour.
 */
import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base(props: IconProps) {
  const { size = 20, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };
}

/** A found idea — four-point spark. Suggest Something, the auto-recommendation "Plot" badge. */
export function IconSpark(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 2.5 L11.6 8.4 L17.5 10 L11.6 11.6 L10 17.5 L8.4 11.6 L2.5 10 L8.4 8.4 Z" />
    </svg>
  );
}

/** A place — pin outline. Share a place, location chips, directions. */
export function IconPlace(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 17.5s6-5.2 6-9.7A6 6 0 0 0 4 7.8c0 4.5 6 9.7 6 9.7Z" />
      <circle cx="10" cy="7.8" r="2.1" />
    </svg>
  );
}

/** A poll — stacked horizontal bars. Poll the group, poll status lines. */
export function IconPoll(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="3.5" width="9" height="3.4" rx="1.2" />
      <rect x="2.5" y="8.3" width="15" height="3.4" rx="1.2" />
      <rect x="2.5" y="13.1" width="6" height="3.4" rx="1.2" />
    </svg>
  );
}

/** Availability — a calendar with one marked day. Check availability, upcoming-plan status. */
export function IconCalendar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.75" y="4" width="14.5" height="13" rx="2.2" />
      <path d="M2.75 8h14.5" />
      <path d="M6.5 2.5v3M13.5 2.5v3" />
      <circle cx="10" cy="12.3" r="1.35" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Log a plan — a simple flag on a post. Log a plan, plan-list rows. */
export function IconFlag(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 17.5V3" />
      <path d="M5 4c1.4-1 3-1 4.4 0s3 1 4.4 0v7c-1.4 1-3 1-4.4 0s-3-1-4.4 0Z" />
    </svg>
  );
}

/**
 * Committed — Plot's own mark for "decided", not a padlock. Three loose points (people/options
 * around an idea — the same territory IconGathering draws mid-motion) resolved into one solid
 * point with short converging rays, as if they'd just landed there. Deliberately the settled
 * counterpart to IconSpark's open four-point outline: a spark is a possibility, this is a
 * possibility that just became definite. Used for Lock It In and every "locked/confirmed" state
 * — see docs/DECISIONS.md#plot-brand-system for why a padlock (or a lock emoji) was wrong here:
 * this is one of Plot's two or three signature actions and deserved a mark nobody else owns.
 */
export function IconLock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10.5" r="2.6" fill="currentColor" stroke="none" />
      <path d="M10 6.3V3.2" />
      <path d="M13.6 12.6 16.3 14.15" />
      <path d="M6.4 12.6 3.7 14.15" />
    </svg>
  );
}

/**
 * Not yet resolved — the same three points as IconLock's rays, still loose. What a proposed
 * idea/suggestion looks like before a Crew converges on it: an automatic recommendation
 * ("Plot found this"), a plan still gathering votes. Deliberately not a sparkle/magic-wand mark
 * — a recommendation is Plot noticing a pattern in what the Crew already likes, not "AI magic".
 */
export function IconGathering(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="4.6" r="1.5" />
      <circle cx="15" cy="14" r="1.5" />
      <circle cx="5" cy="14" r="1.5" />
    </svg>
  );
}

/** A conversation. Talk step, message-a-crew actions. */
export function IconChat(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 4.75h14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H8.4L4.4 17V14H3a1 1 0 0 1-1-1V5.75a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

/** A map, folded. Map/list toggle (map state). */
export function IconMap(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7.2 4 2.5 5.6v10.4L7.2 14.4l5.6 1.6 4.7-1.6V4L12.8 5.6 7.2 4Z" />
      <path d="M7.2 4v10.4M12.8 5.6V16" />
    </svg>
  );
}

/** Stacked rows. Map/list toggle (list state). */
export function IconList(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 5.5h10.5M7 10h10.5M7 14.5h10.5" />
      <circle cx="3" cy="5.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="14.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Happening imminently. "Tonight" time badge on Plans. */
export function IconFlame(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 17.2c-3.3 0-5.4-2.1-5.4-4.9 0-1.9 1-3.2 1.9-4.4-.1 1.2.4 1.9 1 2.1-.3-2.3.6-4.6 3-6.3-.4 1.7.1 3 1.1 3.9 1.3 1.2 2.8 2.5 2.8 4.7 0 2.8-2.1 4.9-5.4 4.9Z" />
    </svg>
  );
}

/** A compass. Page-not-found wayfinding. */
export function IconCompass(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M12.6 7.4 11 11l-3.6 1.6L9 9Z" />
    </svg>
  );
}
