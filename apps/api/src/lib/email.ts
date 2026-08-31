import nodemailer from 'nodemailer';
import { config, providerReadiness } from './config';
import { logger } from './logger';

/**
 * Real transactional email, via whichever of two paths is configured — see
 * docs/providers/email.md for setup of either. Not exercised against a live account from this
 * environment (outbound network to smtp.gmail.com/api.postmarkapp.com isn't reachable from the
 * sandbox this was written in) — verify against Render's logs once real credentials are
 * configured there.
 *
 * Callers should only invoke this when `providerReadiness.smtpEmail || providerReadiness.
 * postmarkEmail` is true — see services/auth.ts#requestMagicLink for the guard and the
 * dev-mode fallback when neither is.
 */
export class EmailError extends Error {}

// Some hosts block outbound SMTP ports outright (common anti-spam-abuse policy on shared
// PaaS infrastructure) — without an explicit timeout, a blocked connection doesn't fail, it
// just hangs, which would hang the whole sign-in request (and, since fetch() has no default
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

/** SMTP first — it's the path that's actually been reachable without a work email/domain
 * (any mailbox you can already log into, Gmail's App Passwords in particular). Postmark stays
 * available for whenever a verified domain exists. */
export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  if (providerReadiness.smtpEmail) return sendViaSmtp(to, url);
  return sendViaPostmark(to, url);
}
