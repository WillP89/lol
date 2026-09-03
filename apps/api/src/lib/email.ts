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
 * Callers should only invoke `sendEmail` (or one of the templated helpers below) when
 * `providerReadiness.resendEmail || providerReadiness.smtpEmail || providerReadiness.postmarkEmail`
 * is true — see services/auth.ts#requestMagicLink for the guard-and-dev-fallback pattern every
 * other caller (crew invites, message-digest notifications) follows too.
 */
export class EmailError extends Error {}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// Some hosts block outbound SMTP ports outright (Render confirmed to be one — see the module
// comment above) — without an explicit timeout, a blocked connection doesn't fail, it just
// hangs, which would hang the whole calling request (and, since fetch() has no default
// timeout, the browser too) indefinitely instead of falling through to whatever dev-mode
// fallback the caller has. 8s is generous for a real SMTP handshake and short enough that a
// blocked port fails fast instead of silently stalling.
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

function magicLinkBody(url: string): EmailContent {
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
async function sendViaResend(to: string, content: EmailContent): Promise<void> {
  const { subject, text, html } = content;
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

async function sendViaSmtp(to: string, content: EmailContent): Promise<void> {
  const { subject, text, html } = content;
  try {
    await getSmtpTransport().sendMail({ from: config.EMAIL_FROM, to, subject, text, html });
  } catch (err) {
    throw new EmailError(`SMTP send failed: ${String(err)}`);
  }
}

async function sendViaPostmark(to: string, content: EmailContent): Promise<void> {
  const { subject, text, html } = content;
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

/**
 * The one real send path every templated email helper below (and the magic link) routes
 * through — generalised out of what used to be three magic-link-only functions so a crew
 * invite or a message-digest notification isn't a hardcoded-body duplicate of the same
 * provider-selection logic. Resend first — HTTP, not raw SMTP, so it isn't subject to the
 * port-blocking that broke SMTP on Render specifically. SMTP stays available for hosts that
 * don't block it. Postmark stays available for whenever a verified domain exists (better
 * deliverability reputation at real volume than either).
 */
export async function sendEmail(to: string, content: EmailContent): Promise<void> {
  if (providerReadiness.resendEmail) return sendViaResend(to, content);
  if (providerReadiness.smtpEmail) return sendViaSmtp(to, content);
  return sendViaPostmark(to, content);
}

export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  return sendEmail(to, magicLinkBody(url));
}

/**
 * A real, explicit person-to-person invite — "willproud89@gmail.com goes to add someone to a
 * crew, types their email, and they get an invite link to join" (the literal ask this exists
 * for). `inviterName` is never blindly trusted as HTML — escaped the same as every other
 * user-authored string that ends up in an email body (crewName included), since both come from
 * data a real Plot user controls (their own display name, their Crew's own name).
 */
export function crewInviteBody(params: { crewName: string; inviterName: string; joinUrl: string }): EmailContent {
  const { crewName, inviterName, joinUrl } = params;
  const safeCrewName = escapeHtml(crewName);
  const safeInviterName = escapeHtml(inviterName);
  return {
    subject: `${inviterName} invited you to ${crewName} on Plot`,
    text: `${inviterName} added you to "${crewName}" on Plot — the app that turns "we should do something" into an actual plan.\n\nJoin here:\n${joinUrl}\n\nIf you weren't expecting this, you can just ignore it.`,
    html: `
      <p>${safeInviterName} added you to <strong>${safeCrewName}</strong> on Plot — the app that turns "we should do something" into an actual plan.</p>
      <p><a href="${joinUrl}" style="display:inline-block;background:#0c0c0d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:100px;font-weight:700">Join ${safeCrewName} →</a></p>
      <p style="color:#888;font-size:13px">If you weren't expecting this, you can just ignore it.</p>
    `,
  };
}

/**
 * The email half of the new-message notification digest (services/messageNotifications.ts owns
 * WHEN this fires — debounced, batched, opt-out-able; this is only the template). Lists up to a
 * handful of the most recent unread messages so the email is actually useful on its own, not
 * just a bare "go check the app" ping, with a real overflow count when there's more than that.
 */
export function crewMessageDigestBody(params: {
  crewName: string;
  crewUrl: string;
  items: { authorName: string; preview: string }[];
  totalUnread: number;
}): EmailContent {
  const { crewName, crewUrl, items, totalUnread } = params;
  const safeCrewName = escapeHtml(crewName);
  const overflow = totalUnread - items.length;
  const subject =
    totalUnread === 1
      ? `${items[0]?.authorName ?? 'Someone'} messaged in ${crewName}`
      : `${totalUnread} new messages in ${crewName}`;

  const textLines = items.map((i) => `${i.authorName}: ${i.preview}`);
  const htmlLines = items
    .map((i) => `<p style="margin:0 0 8px"><strong>${escapeHtml(i.authorName)}:</strong> ${escapeHtml(i.preview)}</p>`)
    .join('');

  return {
    subject,
    text: `${textLines.join('\n')}${overflow > 0 ? `\n\n+${overflow} more` : ''}\n\nOpen the conversation:\n${crewUrl}`,
    html: `
      <p style="font-weight:700;margin:0 0 12px">${safeCrewName}</p>
      ${htmlLines}
      ${overflow > 0 ? `<p style="color:#888;font-size:13px">+${overflow} more</p>` : ''}
      <p><a href="${crewUrl}" style="display:inline-block;background:#0c0c0d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:100px;font-weight:700;margin-top:8px">Open ${safeCrewName} →</a></p>
    `,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
