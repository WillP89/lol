# Going live: Apple / Google sign-in

Adapter interface + authorization-URL builders exist in `src/providers/oauth/index.ts`;
`exchangeCodeForProfile` throws a clear error until credentials are configured, and
`GET /auth/providers` reports live status so the web app can hide the button rather than
offer a dead flow.

## Google
1. Create an OAuth client in Google Cloud Console (console.cloud.google.com → APIs & Services
   → Credentials). Application type: Web application.
2. Authorised redirect URI: `${WEB_APP_URL}/auth/google/callback`.
3. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Implement `exchangeCodeForProfile`: POST the code to `https://oauth2.googleapis.com/token`,
   then GET `https://openidconnect.googleapis.com/v1/userinfo` with the access token.

## Apple ("Sign in with Apple")
1. Apple Developer Program membership (paid, $99/yr) required.
2. Create an App ID + a Services ID (developer.apple.com/account/resources/identifiers).
3. Generate a private key for Sign in with Apple; Apple's OAuth "client secret" is a **signed
   JWT you generate yourself** from that key (ES256, ~6 month max expiry), not a static
   string — this needs a small script (`scripts/generate-apple-secret.ts`, not yet written) run
   on a schedule to rotate it.
4. Set `APPLE_OAUTH_CLIENT_ID` (the Services ID) and `APPLE_OAUTH_CLIENT_SECRET` (the
   generated JWT).
5. Apple's callback is `response_mode=form_post` — the callback route needs to accept a POST
   body, not query params (already reflected in `getAuthorizationUrl`).

## Why email magic-link ships first
No paid developer account, no app review, no redirect-URI allowlisting to coordinate — it's
the only auth method that's fully real today without an external dependency. See
`src/services/auth.ts`.
