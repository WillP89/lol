import { describe, it, expect, vi, afterEach } from 'vitest';
import { readWidthFromHeader, probeImageWidth, MIN_IMAGE_WIDTH } from '../../src/lib/imageDimensions';

/** Builds a minimal-but-real PNG header: signature + IHDR chunk carrying the given width. */
function pngHeader(width: number, height = 100): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR', 'ascii');
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  const rest = Buffer.alloc(5); // bit depth, color type, compression, filter, interlace
  return Buffer.concat([sig, len, type, dims, rest]);
}

/** A minimal, spec-accurate JPEG: SOI, one APP0 filler segment, then an SOF0 carrying the
 *  given width — exactly the shape a real photo's header takes, just with no actual pixel data. */
function jpegHeader(width: number, height = 100): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), Buffer.from([0x00, 0x10]), Buffer.alloc(14)]);
  const sof0Payload = Buffer.alloc(15);
  sof0Payload.writeUInt8(8, 0); // precision
  sof0Payload.writeUInt16BE(height, 1);
  sof0Payload.writeUInt16BE(width, 3);
  sof0Payload.writeUInt8(3, 5); // 3 components
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), Buffer.from([0x00, 0x11]), sof0Payload]);
  return Buffer.concat([soi, app0, sof0]);
}

function webpVp8xHeader(width: number, height = 100): Buffer {
  const riff = Buffer.from('RIFF', 'ascii');
  const size = Buffer.alloc(4);
  const webp = Buffer.from('WEBP', 'ascii');
  const vp8x = Buffer.from('VP8X', 'ascii');
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(10, 0);
  const flags = Buffer.alloc(4);
  const dims = Buffer.alloc(6);
  dims.writeUIntLE(width - 1, 0, 3);
  dims.writeUIntLE(height - 1, 3, 3);
  return Buffer.concat([riff, size, webp, vp8x, chunkSize, flags, dims]);
}

describe('readWidthFromHeader — real pixel width from raw bytes, no metadata trusted', () => {
  it('reads a PNG IHDR width', () => {
    expect(readWidthFromHeader(pngHeader(1024))).toBe(1024);
  });

  it('reads a low-resolution PNG width just as accurately (the whole point of the gate)', () => {
    expect(readWidthFromHeader(pngHeader(150))).toBe(150);
  });

  it('reads a JPEG SOF0 width even behind a preceding APP0 segment', () => {
    expect(readWidthFromHeader(jpegHeader(1200))).toBe(1200);
  });

  it('reads a small JPEG width', () => {
    expect(readWidthFromHeader(jpegHeader(200))).toBe(200);
  });

  it('reads a WEBP VP8X extended-header width', () => {
    expect(readWidthFromHeader(webpVp8xHeader(800))).toBe(800);
  });

  it('returns null (unknown), never a false zero, for an unrecognised format', () => {
    expect(readWidthFromHeader(Buffer.from('not an image, just some bytes'))).toBeNull();
  });

  it('returns null on a truncated JPEG whose SOF marker never arrives in the probed bytes', () => {
    expect(readWidthFromHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});

describe('probeImageWidth — fails open on anything unprovable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the real width for a normal 206 Partial Content response', async () => {
    const body = jpegHeader(1024);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 206,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }));
    expect(await probeImageWidth('https://img.example/photo.jpg')).toBe(1024);
  });

  it('returns null (never rejects blindly) on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    expect(await probeImageWidth('https://img.example/photo.jpg')).toBeNull();
  });

  it('returns null on a hard HTTP failure status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await probeImageWidth('https://img.example/missing.jpg')).toBeNull();
  });

  it('MIN_IMAGE_WIDTH matches the floor every provider adapter already applies', () => {
    expect(MIN_IMAGE_WIDTH).toBe(640);
  });
});
