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
  // The API's own publicly-reachable origin — real bug, caught from a live screenshot: this
  // used to default straight to http://localhost:4000 with no override ever set in the actual
  // Render deployment, so every avatar/Crew-image URL written to the database was literally
  // "your own machine, port 4000" from the viewer's perspective — a guaranteed broken image for
  // every single user, forever. Left optional here on purpose; resolvePublicApiUrl() below is
  // the actual source of truth and auto-detects Render/Railway's own env vars first, only
  // falling back to this (then to localhost, dev-only) if neither is present. See
  // docs/DECISIONS.md#plot-media-storage.
  API_PUBLIC_URL: z.string().url().optional(),
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
  // Optional upgrade path for lib/imageEnrichment.ts's SPORT-category image lookup — unset
  // falls back to TheSportsDB's own published free test key ("123"), which their docs
  // explicitly document as fine for light/testing use but not indefinite production volume.
  // Register a real key at thesportsdb.com/documentation and set this once sync volume
  // justifies it. See docs/providers/food-and-places.md.
  SPORTSDB_API_KEY: z.string().optional(),
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

  // Real persistent object storage for uploaded avatars/Crew images — any S3-compatible
  // provider (Cloudflare R2 recommended: free tier, no egress fees, S3 API-compatible so the
  // same @aws-sdk/client-s3 client works unchanged). Local disk (lib/mediaStorage.ts's other
  // backend) is NOT durable on Render/Railway's default filesystem — it's wiped on every
  // redeploy — so it's dev/test-only; production refuses uploads outright until these are set
  // rather than silently accepting a file that will 404 after the next deploy. See
  // docs/DECISIONS.md#plot-media-storage and docs/DEPLOYMENT.md for exact R2 setup steps.
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Omit for real AWS S3; required for R2/any other S3-compatible endpoint, e.g.
  // https://<account-id>.r2.cloudflarestorage.com.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  // The URL prefix objects are actually reachable at from a browser — R2's own per-bucket
  // r2.dev URL, a custom domain mapped to the bucket, or (for real AWS S3) the bucket's own
  // https://<bucket>.s3.<region>.amazonaws.com. Required whenever S3_BUCKET is set.
  S3_PUBLIC_URL: z.string().url().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration — see stderr for details.');
}

export const config = parsed.data;

/**
 * The API's real, browser-reachable origin — resolved once at startup, not left to a single
 * env var nobody remembers to set. Explicit `API_PUBLIC_URL` always wins; otherwise this reads
 * the hosting platform's own env var for it (Render sets `RENDER_EXTERNAL_URL` automatically on
 * every web service; Railway sets `RAILWAY_PUBLIC_DOMAIN`, a bare hostname needing `https://`
 * prepended) before ever falling back to localhost — and that fallback only fires outside
 * production, so a real deployment with none of these set fails loudly (see the throw below)
 * instead of quietly writing unreachable URLs into the database forever.
 */
function resolvePublicApiUrl(): string {
  if (config.API_PUBLIC_URL) return config.API_PUBLIC_URL;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'No public API URL could be resolved (API_PUBLIC_URL is unset and no platform env var — ' +
        'RENDER_EXTERNAL_URL, RAILWAY_PUBLIC_DOMAIN — was found). Refusing to start in production ' +
        'with this unresolved: every media URL written would be unreachable. Set API_PUBLIC_URL ' +
        'explicitly. See docs/DEPLOYMENT.md.',
    );
  }
  return `http://localhost:${config.PORT}`;
}
export const PUBLIC_API_URL = resolvePublicApiUrl();

export const s3Configured = Boolean(config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY && config.S3_PUBLIC_URL);

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
  mediaStorage: s3Configured,
};
