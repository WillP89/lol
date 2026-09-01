import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail fast on missing config rather than discovering it at 2am from a stack trace. Every
 * required env var is validated here once, at process start.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 chars'),
  TOKEN_HASH_SECRET: z.string().min(16, 'TOKEN_HASH_SECRET must be at least 16 chars'),
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  // The API's own publicly-reachable origin — needed because uploaded media (avatars, Crew
  // images) is served straight from this process (see lib/mediaStorage.ts) at an absolute URL,
  // not proxied through the web app's rewrite the way JSON API calls are. Defaults to the local
  // dev API port; a real deployment must set this to wherever the API is actually reachable
  // from a browser (see docs/DECISIONS.md#plot-media-storage).
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  // Minimal pilot-stage protection for /admin/*: a single shared secret checked via header.
  // NOT real role-based admin auth (brief §29) — see docs/DECISIONS.md#admin-auth for the
  // upgrade path once there's more than one operator.
  ADMIN_API_KEY: z.string().default('dev_admin_key_change_me'),

  // Optional — provider credentials we don't have yet. Adapters check these at runtime and
  // fall back to mock/disabled behaviour rather than crashing the process. See
  // docs/providers/*.md for what's needed to activate each one.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  APPLE_OAUTH_CLIENT_ID: z.string().optional(),
  APPLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  TICKETMASTER_API_KEY: z.string().optional(),
  DICE_API_KEY: z.string().optional(),
  EVENTBRITE_API_KEY: z.string().optional(),
  OPENTABLE_API_KEY: z.string().optional(),
  POSTMARK_API_KEY: z.string().optional(),
  // An HTTP email API (not raw SMTP) — see docs/providers/email.md. Checked ahead of SMTP:
  // SMTP is CONFIRMED blocked outbound on Render (a real send attempt there timed out — Render
  // blocks outbound SMTP ports as an anti-spam-abuse measure), so an HTTP-based sender is what
  // actually has a chance of working there.
  RESEND_API_KEY: z.string().optional(),
  // Plain SMTP — sends through any mailbox you can already log into (Gmail's smtp.gmail.com
  // with an App Password, in particular): no domain verification, no third-party account
  // approval process, just credentials for a mailbox you already have. Confirmed NOT reachable
  // from Render specifically (outbound SMTP ports blocked) — kept for hosts that don't block
  // it. See docs/providers/email.md.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Must be on a domain verified with whichever provider is sending (Resend/Postmark — SPF+DKIM);
  // if sending via SMTP, most providers (Gmail included) require this to match SMTP_USER.
  // plotmaker.co.uk is verified in Resend (SPF/DKIM/MX all green — see docs/providers/email.md),
  // so this default is a real, deliverable sender once RESEND_API_KEY is also set.
  EMAIL_FROM: z.string().email().default('hello@plotmaker.co.uk'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration — see stderr for details.');
}

export const config = parsed.data;

export const providerReadiness = {
  googleOAuth: Boolean(config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET),
  appleOAuth: Boolean(config.APPLE_OAUTH_CLIENT_ID && config.APPLE_OAUTH_CLIENT_SECRET),
  stripe: Boolean(config.STRIPE_SECRET_KEY),
  ticketmaster: Boolean(config.TICKETMASTER_API_KEY),
  dice: Boolean(config.DICE_API_KEY),
  eventbrite: Boolean(config.EVENTBRITE_API_KEY),
  openTable: Boolean(config.OPENTABLE_API_KEY),
  postmarkEmail: Boolean(config.POSTMARK_API_KEY),
  smtpEmail: Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS),
  resendEmail: Boolean(config.RESEND_API_KEY),
};
