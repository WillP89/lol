import { logger } from './logger';

/**
 * The real, provider-agnostic image-quality gate. Ticketmaster and the Wikipedia enrichment
 * path already reject a low-resolution candidate at the point they pick it, because both APIs
 * hand back a real declared width. Skiddle, Eventbrite and OpenStreetMap do NOT — Skiddle's API
 * in particular never reports image dimensions at all, so "some images still look stretched and
 * distorted" (a real, repeated live bug report — see docs/DECISIONS.md#image-quality-floor)
 * cannot be fixed for those sources by trusting provider metadata, because there is none to
 * trust. This probes the ACTUAL bytes instead: a small Range request pulls just the file's
 * header, which is enough to read its real pixel width straight out of the JPEG/PNG/WEBP
 * container — the same floor every other provider adapter already applies
 * (MIN_IMAGE_WIDTH = 640, matching what a hero card actually renders it at), now enforced
 * against ground truth rather than a number the provider chose to report.
 *
 * Deliberately fails OPEN on anything unverifiable (network error, an unsupported format, a CDN
 * that ignores Range and returns the whole file, a parse miss) — this exists to catch a KNOWN
 * low-resolution image, not to silently empty out a provider's whole inventory the moment its
 * CDN behaves unexpectedly. A real, provably-small image is rejected; an unprovable one is kept
 * exactly as available today, no worse than before this existed.
 */
export const MIN_IMAGE_WIDTH = 640;
const PROBE_TIMEOUT_MS = 3500;
// Enough bytes for a JPEG's SOF marker to show up even behind a large EXIF/ICC block, and far
// more than PNG/WEBP ever need for their fixed-offset header — without pulling the whole file.
const PROBE_BYTES = 65536;

/**
 * Reads real pixel width from a JPEG/PNG/WEBP file's header bytes. Returns null (not 0) for
 * "could not determine" — callers must treat null as "unknown", never as "confirmed small".
 */
export function readWidthFromHeader(buf: Buffer): number | null {
  // PNG: fixed 8-byte signature, then an IHDR chunk whose first 4 bytes (offset 16) are the
  // width, big-endian — always at this exact offset for a spec-conformant PNG.
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return buf.readUInt32BE(16);
  }

  // WEBP: RIFF container. Only the two chunk shapes that carry an explicit, easy-to-read width
  // are handled (VP8X extended header, and the simple lossy VP8 bitstream) — a lossless VP8L
  // frame packs width/height into bits, not bytes, and is rare enough from these providers not
  // to be worth the extra parser.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return (buf.readUIntLE(24, 3) + 1);
    if (chunk === 'VP8 ') return buf.readUInt16LE(26) & 0x3fff;
  }

  // JPEG: a stream of markers (0xFF, code, ...). Width lives in the SOF (Start Of Frame)
  // marker's payload — scan forward, skipping every other segment by its own declared length,
  // until a SOF marker turns up (or the buffer runs out, however far it got downloaded).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; } // resync on a stray non-marker byte
      const marker = buf[offset + 1];
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 all carry width at the same payload offset;
      // 0xC4/0xC8/0xCC are DHT/JPG/DAC, not SOF, and must be excluded from that range.
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return buf.readUInt16BE(offset + 7);
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

/** Fetches just enough of `url` to read its real pixel width. null = genuinely couldn't tell
 *  (network failure, server ignored Range, unrecognised format) — see this file's own header
 *  comment for why that's treated as "keep it", not "reject it". */
export async function probeImageWidth(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> {
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
    return readWidthFromHeader(buf);
  } catch (err) {
    logger.warn({ err, url }, 'Image resolution probe failed — keeping the image, not rejecting on an unprovable check');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
