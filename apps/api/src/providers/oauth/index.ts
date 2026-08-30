import { config, providerReadiness } from '../../lib/config';

/**
 * OAuth is scaffolded, not wired to a live flow. Enabling it for real needs, per provider:
 *
 *  Google:  a Google Cloud OAuth client (console.cloud.google.com), authorised redirect URI
 *           set to `${WEB_APP_URL}/auth/google/callback`, GOOGLE_OAUTH_CLIENT_ID/SECRET set.
 *  Apple:   an Apple Developer "Sign in with Apple" Services ID + private key
 *           (developer.apple.com/account/resources/identifiers), APPLE_OAUTH_CLIENT_ID/SECRET
 *           set (Apple's "secret" is a signed JWT, not a static string — see
 *           docs/providers/oauth.md for the generation script this needs).
 *
 * Once configured, implement `exchangeCodeForProfile` per provider and call
 * `linkOrCreateUserFromOAuth` (services/auth.ts — not yet written, see TODO there) from a new
 * `/auth/:provider/callback` route mirroring the shape of the magic-link callback.
 */
export interface OAuthProfile {
  providerUserId: string;
  email: string;
  displayName?: string;
}

export interface OAuthAdapter {
  id: 'google' | 'apple';
  isConfigured: boolean;
  getAuthorizationUrl(state: string): string;
  exchangeCodeForProfile(code: string): Promise<OAuthProfile>;
}

export const googleOAuthAdapter: OAuthAdapter = {
  id: 'google',
  isConfigured: providerReadiness.googleOAuth,
  getAuthorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: config.GOOGLE_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${config.WEB_APP_URL}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },
  async exchangeCodeForProfile() {
    throw new Error(
      'Google OAuth is not configured — set GOOGLE_OAUTH_CLIENT_ID/SECRET. See docs/providers/oauth.md.',
    );
  },
};

export const appleOAuthAdapter: OAuthAdapter = {
  id: 'apple',
  isConfigured: providerReadiness.appleOAuth,
  getAuthorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: config.APPLE_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${config.WEB_APP_URL}/auth/apple/callback`,
      response_type: 'code',
      scope: 'name email',
      response_mode: 'form_post',
      state,
    });
    return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
  },
  async exchangeCodeForProfile() {
    throw new Error(
      'Apple OAuth is not configured — set APPLE_OAUTH_CLIENT_ID/SECRET. See docs/providers/oauth.md.',
    );
  },
};

export function oauthProviderStatus(): Record<string, boolean> {
  return {
    google: googleOAuthAdapter.isConfigured,
    apple: appleOAuthAdapter.isConfigured,
    email: true,
  };
}
