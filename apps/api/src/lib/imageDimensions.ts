import { logger } from './logger';

/**
 * THE real, provider-agnostic image-quality gate — hardened repeatedly after live reports that
 * imagery still looked "distorted and shit quality" kept recurring even after each previous
 * pass. CSS is not the cause — every background-image in this codebase renders via `center/cover`
 * (which crops, never skews an aspect ratio; verified by grepping every `background:`/
 * `backgroundImage` site in apps/web), so a "distorted" report is a property of the SOURCE FILE,
 * not the CSS. Two real, independently-checkable properties of a source file explain that report:
 * it's genuinely low-resolution (gets visibly blown up at hero-card size), or its aspect ratio is
 * so extreme that a `cover` crop leaves an unnaturally tight/warped-looking slice. Both are now
 * checked from the real bytes, for EVERY provider without exception — a provider's own declared
 * width is no longer trusted on its own, because a declared-but-unverified number clearly wasn't
 * a strong enough bar.
 *
 * THE FLOOR ITSELF was still wrong even once every provider was byte-verified against it — found
 * only by measuring the actual on-screen math, not by raising the number again and hoping: Home's
 * hero (apps/web/src/app/home/page.tsx, `.v2-bleed` inside `.v2-home-page`) is this app's single
 * largest, most prominent image placement, and renders at up to 720px + 40px of bleed = 760px of
 * real CSS width on desktop. A perfectly "passing" 1000px-wide source is still, on ANY standard 2x
 * retina/HiDPI display (the default on every current Mac and iPhone, and most modern Windows/
 * Android screens) — 760 × 2 = 1520 physical pixels needed to render pixel-for-pixel sharp —
 * visibly upscaled by ~1.5x at exactly the spot users look at first. That is a real, measurable,
 * device-pixel-ratio upscale, not a subjective "doesn't feel HD enough" — the previous floor was
 * simply never high enough to be genuinely crisp in the app's own biggest placement, on the most
 * common class of screen there is. 1600 clears that math with real margin (760×2=1520) rather than
 * sitting exactly on the edge of it.
 */
export const MIN_IMAGE_WIDTH = 1600;
// A `cover` crop never skews an image, but an extreme source aspect ratio still produces an
// unnaturally tight/awkward-looking result once cropped to a card's own box — a real, distinct
// failure mode from low resolution, not covered by the width floor alone.
export const MIN_ASPECT_RATIO = 0.45; // no more portrait than roughly 9:20
export const MAX_ASPECT_RATIO = 3.2; // no more panoramic than roughly 16:5

const PROBE_TIMEOUT_MS = 3500;
// Enough bytes for a JPEG's SOF marker to show up even behind a large EXIF/ICC block, and far
// more than PNG/WEBP ever need for their fixed-offset header — without pulling the whole file.
const PROBE_BYTES = 65536;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Reads real pixel dimensions from a JPEG/PNG/WEBP file's header bytes. Returns null (not a
 * zeroed object) for "could not determine" — callers must treat null as "unknown", never as
 * "confirmed bad".
 */
export function readDimensionsFromHeader(buf: Buffer): ImageDimensions | null {
  // PNG: fixed 8-byte signature, then an IHDR chunk whose first 8 bytes (offset 16) are width
  // then height, both big-endian — always at this exact offset for a spec-conformant PNG.
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // WEBP: RIFF container. Only the two chunk shapes that carry explicit, easy-to-read dimensions
  // are handled (VP8X extended header, and the simple lossy VP8 bitstream) — a lossless VP8L
  // frame packs width/height into bits, not bytes, and is rare enough from these providers not
  // to be worth the extra parser.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }

  // JPEG: a stream of markers (0xFF, code, ...). Dimensions live in the SOF (Start Of Frame)
  // marker's payload — scan forward, skipping every other segment by its own declared length,
  // until a SOF marker turns up (or the buffer runs out, however far it got downloaded).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; } // resync on a stray non-marker byte
      const marker = buf[offset + 1];
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 all carry dimensions at the same payload
      // offset; 0xC4/0xC8/0xCC are DHT/JPG/DAC, not SOF, and must be excluded from that range.
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; // markers with no length-prefixed payload
        continue;
      }
      const segmentLength = buf.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    }
  }

  return null; // not a recognised format, or the SOF marker didn't show up within PROBE_BYTES
}

/** Back-compat single-value accessor — most callers only ever needed the width; kept so the
 *  existing unit tests (test/unit/imageDimensions.test.ts) exercise the exact same parser. */
export function readWidthFromHeader(buf: Buffer): number | null {
  return readDimensionsFromHeader(buf)?.width ?? null;
}

/** Fetches just enough of `url` to read its real pixel dimensions. null = genuinely couldn't
 *  tell (network failure, server ignored Range, unrecognised format) — treated as "keep it", not
 *  "reject it", so a probe failure never turns a working sync into a broken one. */
export async function probeImageDimensions(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ImageDimensions | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}`, 'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; image-quality-check)' },
    });
    // A 200 (Range ignored, whole file came back) is still fine to read from — only a hard
    // failure status is genuinely "couldn't check this".
    if (!res.ok && res.status !== 206) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return readDimensionsFromHeader(buf);
  } catch (err) {
    logger.warn({ err, url }, 'Image dimension probe failed — keeping the image, not rejecting on an unprovable check');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True only when the real bytes PROVE this image fails the floor or the aspect-ratio sanity
 *  check — an unprovable result (probe failure, unrecognised format) is never treated as a
 *  failure, see this file's own header comment. */
export async function isImageQualityBad(url: string): Promise<boolean> {
  const dims = await probeImageDimensions(url);
  if (!dims) return false;
  if (dims.width < MIN_IMAGE_WIDTH) return true;
  const ratio = dims.width / Math.max(dims.height, 1);
  return ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO;
}

/** Back-compat wrapper — some callers only want the raw width (e.g. a resolution-only decision
 *  made against a provider's own declared value before ever probing). */
export async function probeImageWidth(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> {
  const dims = await probeImageDimensions(url, timeoutMs);
  return dims?.width ?? null;
}
