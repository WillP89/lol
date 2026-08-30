const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };

function symbol(currency: string): string {
  return CURRENCY_SYMBOL[currency] ?? `${currency} `;
}

/**
 * One place for "how do we show a price" so every surface (Explore, Find Us Something, chat's
 * shared-event cards, Plan Card) agrees — including the one thing every one of them got wrong
 * before this existed: a free event (priceMinMinor === 0) rendering as "from £0", which reads
 * like a pricing bug, not a feature.
 */
export function formatPriceFrom(priceMinMinor: number | null, currency = 'GBP'): string | null {
  if (priceMinMinor === null) return null;
  if (priceMinMinor === 0) return 'free';
  return `from ${symbol(currency)}${(priceMinMinor / 100).toFixed(0)}`;
}

export function formatPriceRange(priceMinMinor: number | null, priceMaxMinor: number | null | undefined, currency = 'GBP'): string | null {
  if (priceMinMinor === null) return null;
  if (priceMinMinor === 0 && (!priceMaxMinor || priceMaxMinor === 0)) return 'free';
  const sym = symbol(currency);
  if (priceMaxMinor && priceMaxMinor !== priceMinMinor) {
    return `${sym}${(priceMinMinor / 100).toFixed(0)}–${sym}${(priceMaxMinor / 100).toFixed(0)}`;
  }
  return `from ${sym}${(priceMinMinor / 100).toFixed(0)}`;
}
