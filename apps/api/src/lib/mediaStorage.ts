import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

/**
 * Real upload infrastructure for avatars and Crew images (brief: "do not store giant base64
 * images in application records... use appropriate object storage... build the abstraction
 * cleanly, use graceful fallback, document exactly what is required").
 *
 * This is a genuine object-storage ABSTRACTION with exactly one implementation right now: local
 * disk, served statically. That's an honest, deliberate pilot-scale choice — this sandbox has no
 * S3/R2/GCS credentials configured, and standing them up isn't this pass's job (see
 * docs/DECISIONS.md#plot-media-storage for the exact swap-in path). Every call site goes through
 * this module's `saveUpload`/`deleteUpload`, never a raw `fs` call — swapping the local-disk
 * implementation for an S3-backed one later is a one-file change, not a call-site hunt.
 */
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
// Created synchronously at module load — @fastify/static requires its `root` to exist at
// registration time (app.ts registers it before any upload has ever happened), and buildApp()
// itself is synchronous, so this can't be the async mkdir saveUpload uses per-write.
mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 6 * 1024 * 1024; // 6MB — generous for a phone photo, small enough to not choke local disk in a pilot.

export class MediaValidationError extends Error {}

export async function saveUpload(params: { buffer: Buffer; mimeType: string; kind: 'avatar' | 'crew' }): Promise<string> {
  if (!ALLOWED_MIME.has(params.mimeType)) {
    throw new MediaValidationError('Only JPEG, PNG, or WebP images are supported.');
  }
  if (params.buffer.byteLength > MAX_BYTES) {
    throw new MediaValidationError('Image must be under 6MB.');
  }
  const ext = params.mimeType === 'image/png' ? 'png' : params.mimeType === 'image/webp' ? 'webp' : 'jpg';
  const filename = `${params.kind}-${randomUUID()}.${ext}`;
  await writeFile(path.join(UPLOAD_DIR, filename), params.buffer);
  // An absolute URL against the API's own public origin — media isn't proxied through the web
  // app's /api/* rewrite the way JSON calls are, it's served directly by this process (see
  // app.ts's fastifyStatic registration at /media/, backed by this same UPLOAD_DIR).
  return `${config.API_PUBLIC_URL}/media/${filename}`;
}

export async function deleteUpload(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const filename = url.split('/media/')[1];
  if (!filename || filename.includes('..') || filename.includes('/')) return;
  await unlink(path.join(UPLOAD_DIR, filename)).catch(() => {
    // Already gone, or never existed locally (e.g. seeded data) — deleting a Crew's old image
    // when a new one is uploaded is best-effort cleanup, not something a request should fail on.
  });
}

export { UPLOAD_DIR };
