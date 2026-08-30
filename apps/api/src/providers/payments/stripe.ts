import { config, providerReadiness } from '../../lib/config';

/**
 * Native checkout (Booking Model D). See docs/providers/payments.md for what's needed to
 * activate this — a verified Stripe business account, a payments-topology decision (merchant
 * of record vs pass-through), and a webhook endpoint. Until then every function here throws a
 * clear, specific error rather than silently no-op-ing, so a caller can't accidentally believe
 * a payment succeeded.
 */
export function isStripeConfigured(): boolean {
  return providerReadiness.stripe;
}

export async function createPaymentIntent(_params: {
  amountMinor: number;
  currency: string;
  bookingId: string;
}): Promise<{ clientSecret: string; providerIntentId: string }> {
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error(
      'Stripe is not configured (STRIPE_SECRET_KEY missing). Native checkout (Booking Model D) ' +
        'is unavailable — use Booking Model A (deep link) instead. See docs/providers/payments.md.',
    );
  }
  // Real implementation once configured: `new Stripe(config.STRIPE_SECRET_KEY).paymentIntents.create(...)`.
  throw new Error('Stripe SDK call not yet implemented — see docs/providers/payments.md.');
}
