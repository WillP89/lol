import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config, s3Configured, PUBLIC_API_URL } from './config';

/**
 * Real, persistent upload infrastructure for avatars and Crew images (brief: "do not store
 * giant base64 images... use appropriate object storage... build the abstraction cleanly, use
 * graceful fallback, document exactly what is required").
 *
 * REAL BUG this replaced, caught from a live screenshot (a blue broken-image icon on a real
 * uploaded avatar): the previous version was local-disk only, always — which is NOT durable on
 * Render/Railway's default filesystem (wiped on every redeploy), and separately the URL it
 * generated pointed at `http://localhost:4000`, meaningless outside this dev sandbox, because
 * nothing had ever set `API_PUBLIC_URL` in the real deployment. Two independent bugs stacked:
 * even a correctly-configured URL would have gone stale on the next deploy. See
 * docs/DECISIONS.md#plot-media-storage and docs/DEPLOYMENT.md for the fix and setup steps.
 *
 * Two real backends now, chosen once at module load by whether S3 credentials are configured
 * (`s3Configured`, config.ts) — never silently guessed:
 *  - S3-compatible object storage (Cloudflare R2 recommended: free tier, S3 API-compatible, no
 *    egress fees) — the only backend this app will actually accept uploads through outside
 *    development. This is what makes an uploaded photo survive a redeploy.
 *  - Local disk — kept ONLY for local development/tests, where redeploys don't happen and
 *    nobody's photo needs to survive one. In production without S3 configured, uploads are
 *    refused outright (a clear error) rather than silently accepted onto disk that won't last.
 */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 6 * 1024 * 1024; // 6MB — generous for a phone photo, small enough to not choke local disk in dev.

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!s3Configured) {
  // @fastify/static (app.ts) needs this directory to exist at registration time regardless of
  // which backend ends up serving a given request — harmless to create even when S3 is what's
  // actually used, since nothing ever writes into it in that case.
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const s3Client = s3Configured
  ? new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
    })
  : null;

export class MediaValidationError extends Error {}
/** Distinct from MediaValidationError (a bad file) — this means storage itself isn't set up,
 * which a route handler should report as a 503 ("uploads aren't available yet"), not a 400. */
export class MediaStorageUnavailableError extends Error {}

export async function saveUpload(params: { buffer: Buffer; mimeType: string; kind: 'avatar' | 'crew' }): Promise<string> {
  if (!ALLOWED_MIME.has(params.mimeType)) {
    throw new MediaValidationError('Only JPEG, PNG, or WebP images are supported.');
  }
  if (params.buffer.byteLength > MAX_BYTES) {
    throw new MediaValidationError('Image must be under 6MB.');
  }
  const ext = params.mimeType === 'image/png' ? 'png' : params.mimeType === 'image/webp' ? 'webp' : 'jpg';
  const filename = `${params.kind}-${randomUUID()}.${ext}`;

  if (s3Client) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: filename,
        Body: params.buffer,
        ContentType: params.mimeType,
        CacheControl: 'public, max-age=31536000, immutable', // filenames are random UUIDs — never reused, safe to cache forever
      }),
    );
    return `${config.S3_PUBLIC_URL}/${filename}`;
  }

  if (config.NODE_ENV === 'production') {
    // Never silently accept an upload onto disk that a redeploy will wipe — that's exactly the
    // "quietly broken later" failure mode this whole rewrite exists to close off.
    throw new MediaStorageUnavailableError('Image uploads are not available yet — storage isn’t configured. Ask the developer to set up S3/R2 (see docs/DEPLOYMENT.md).');
  }
  await writeFile(path.join(UPLOAD_DIR, filename), params.buffer);
  return `${PUBLIC_API_URL}/media/${filename}`;
}

export async function deleteUpload(url: string | null | undefined): Promise<void> {
  if (!url) return;
  if (s3Client) {
    const key = url.split('/').pop();
    if (!key) return;
    await s3Client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key })).catch(() => {
      // Best-effort cleanup — an old image outliving its replacement by a few bytes in the
      // bucket is not worth failing the request that's replacing it.
    });
    return;
  }
  const filename = url.split('/media/')[1];
  if (!filename || filename.includes('..') || filename.includes('/')) return;
  await unlink(path.join(UPLOAD_DIR, filename)).catch(() => {
    // Already gone, or never existed locally (e.g. seeded data) — same best-effort reasoning.
  });
}

export { UPLOAD_DIR };
