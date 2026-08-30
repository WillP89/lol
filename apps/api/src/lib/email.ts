import { config } from './config';
import { logger } from './logger';

/**
 * Real transactional email via Postmark's REST API — no SDK dependency, it's a single POST.
 * See docs/providers/email.md for setup (verified sending domain, SPF/DKIM). Not exercised
 * against a live Postmark account from this environment (outbound network to
 * api.postmarkapp.com isn't reachable from the dev sandbox this was written in) — verify
 * against Render's logs once POSTMARK_API_KEY is configured there.
 *
 * Callers should only invoke this when `providerReadiness.postmarkEmail` is true — see
 * services/auth.ts#requestMagicLink for the guard and the dev-mode fallback when it isn't.
 */
export class EmailError extends Error {}

export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': config.POSTMARK_API_KEY ?? '',
    },
    body: JSON.stringify({
      From: config.EMAIL_FROM,
      To: to,
      Subject: 'Your Plot sign-in link',
      MessageStream: 'outbound',
      TextBody: `Tap this link to sign in to Plot:\n\n${url}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request this, you can ignore this email.`,
      HtmlBody: `<p>Tap this link to sign in to Plot:</p><p><a href="${url}">${url}</a></p><p style="color:#888;font-size:13px">This link expires in 15 minutes and can only be used once. If you didn't request this, you can ignore this email.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body }, 'Postmark send failed');
    throw new EmailError(`Postmark returned ${res.status}`);
  }
}
