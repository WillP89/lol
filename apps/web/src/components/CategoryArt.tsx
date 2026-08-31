import { categoryStyle } from '@/lib/categoryStyle';

/**
 * The designed fallback for an event with no real photo — every provider (including a live
 * Ticketmaster feed) occasionally has one, and 100% of sample/mock data does, since faking a
 * "real" photo (a picsum.photos seed was tried and dropped — see docs/DECISIONS.md
 * #category-art) is worse than an honest, well-composed category treatment: a rich gradient
 * with a large mark bled off one edge and a small type label, not an emoji floating dead-centre
 * in a flat rectangle. One shared component so every surface (Explore, Home, Plans, chat's
 * event cards) gets the identical, intentional treatment instead of six slightly different
 * ad-hoc divs.
 */
export function CategoryArt({ category, compact = false }: { category: string | null | undefined; compact?: boolean }) {
  const style = categoryStyle(category);
  return (
    <div style={{ position: 'absolute', inset: 0, background: style.bg, overflow: 'hidden' }}>
      {/* A soft top-left highlight gives the flat gradient some depth — a lighting effect, not
          a sticker. */}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 140% 90% at 15% 0%, rgba(255,255,255,0.14), transparent 55%)' }} />
      {/* The mark itself: large, bled off the bottom-right corner, low-opacity — a texture, not
          a label. Real imagery (once a live provider is connected) replaces this entirely. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          right: compact ? -10 : -18,
          bottom: compact ? -14 : -24,
          fontSize: compact ? 56 : 92,
          opacity: 0.28,
          lineHeight: 1,
          filter: 'saturate(0.7)',
        }}
      >
        {style.emoji}
      </div>
      {!compact && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            bottom: 10,
            fontSize: 10.5,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'rgba(247,240,228,0.75)',
          }}
        >
          {(category ?? '').replace(/_/g, ' ').toLowerCase()}
        </div>
      )}
    </div>
  );
}
