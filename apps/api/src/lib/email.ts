import nodemailer from 'nodemailer';
import { config, providerReadiness } from './config';
import { logger } from './logger';

/**
 * Real transactional email, via whichever of three paths is configured — see
 * docs/providers/email.md for setup of each. None has been exercised against a live account
 * from this environment (outbound network to api.resend.com/smtp.gmail.com/api.postmarkapp.com
 * isn't reachable from the sandbox this was written in) — verify against the deployed
 * service's logs once real credentials are configured. SMTP specifically is CONFIRMED not to
 * work on Render — a real attempt there timed out (Render blocks outbound SMTP ports as an
 * anti-spam-abuse measure, a common PaaS policy) — kept only for hosts that don't block it.
 *
 * Callers should only invoke this when `providerReadiness.resendEmail ||
 * providerReadiness.smtpEmail || providerReadiness.postmarkEmail` is true — see
 * services/auth.ts#requestMagicLink for the guard and the dev-mode fallback when none is.
 */
export class EmailError extends Error {}

// Some hosts block outbound SMTP ports outright (Render confirmed to be one — see the module
// comment above) — without an explicit timeout, a blocked connection doesn't fail, it just
// hangs, which would hang the whole sign-in request (and, since fetch() has no default
// timeout, the browser too) indefinitely instead of falling through to the dev-link fallback
// below. 8s is generous for a real SMTP handshake and short enough that a blocked port fails
// fast instead of silently stalling sign-in.
const SMTP_TIMEOUT_MS = 8000;

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465, // Gmail: 465 = implicit TLS, 587 = STARTTLS
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }
  return smtpTransport;
}

function magicLinkBody(url: string) {
  return {
    subject: 'Your Plot sign-in link',
    text: `Tap this link to sign in to Plot:\n\n${url}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request this, you can ignore this email.`,
    html: `<p>Tap this link to sign in to Plot:</p><p><a href="${url}">${url}</a></p><p style="color:#888;font-size:13px">This link expires in 15 minutes and can only be used once. If you didn't request this, you can ignore this email.</p>`,
  };
}

/**
 * Resend — an HTTP API (regular HTTPS, port 443), not a raw SMTP socket, so it isn't subject
 * to the outbound-port blocking that broke the SMTP path on Render. UNVERIFIED CAVEAT, same
 * honesty bar as the Eventbrite adapter: Resend's shared `onboarding@resend.dev` sender needs
 * no domain verification, but some email HTTP APIs restrict a from-their-own-shared-domain
 * sender to only deliver to the account owner's own verified address until a real domain is
 * added — whether that applies here is genuinely unconfirmed from this environment. Test with
 * RESEND_API_KEY set: send to your own signup address first (should work in any sandbox mode),
 * then to a second, different address (a friend's) — if the second one silently doesn't
 * arrive, that's the restriction, and a verified domain (or a different service) is needed for
 * real multi-recipient sending.
 */
async function sendViaResend(to: string, url: string): Promise<void> {
  const { subject, text, html } = magicLinkBody(url);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body }, 'Resend send failed');
    throw new EmailError(`Resend returned ${res.status}`);
  }
}

async function sendViaSmtp(to: string, url: string): Promise<void> {
  const { subject, text, html } = magicLinkBody(url);
  try {
    await getSmtpTransport().sendMail({ from: config.EMAIL_FROM, to, subject, text, html });
  } catch (err) {
    throw new EmailError(`SMTP send failed: ${String(err)}`);
  }
}

async function sendViaPostmark(to: string, url: string): Promise<void> {
  const { subject, text, html } = magicLinkBody(url);
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': config.POSTMARK_API_KEY ?? '',
    },
    body: JSON.stringify({ From: config.EMAIL_FROM, To: to, Subject: subject, MessageStream: 'outbound', TextBody: text, HtmlBody: html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body }, 'Postmark send failed');
    throw new EmailError(`Postmark returned ${res.status}`);
  }
}

/** Resend first — HTTP, not raw SMTP, so it isn't subject to the port-blocking that broke SMTP
 * on Render specifically. SMTP stays available for hosts that don't block it. Postmark stays
 * available for whenever a verified domain exists (better deliverability reputation at real
 * volume than either). */
export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  if (providerReadiness.resendEmail) return sendViaResend(to, url);
  if (providerReadiness.smtpEmail) return sendViaSmtp(to, url);
  return sendViaPostmark(to, url);
}
