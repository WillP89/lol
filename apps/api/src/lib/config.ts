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
  // Must be on a domain verified in Postmark (SPF/DKIM) — see docs/providers/email.md.
  EMAIL_FROM: z.string().email().default('hello@plot.invalid'),
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
};
