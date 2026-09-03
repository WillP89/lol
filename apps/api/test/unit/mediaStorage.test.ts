import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Two real, live-reported bugs this file proves fixed:
 *
 * 1. "Personal picture upload... stopped working... gets stuck on saving" — the S3 client was
 *    constructed without `forcePathStyle`, so the SDK defaulted to virtual-hosted addressing
 *    (`<bucket>.<account-id>.r2.cloudflarestorage.com`), which R2's own wildcard TLS cert
 *    doesn't cover — a stalled handshake, not a clean failure, which is exactly "stuck on
 *    saving forever" rather than a retriable error.
 * 2. Even with that fixed, nothing previously bounded how long an upload could hang — this
 *    proves a genuinely unresponsive upload now fails with a clear, retriable error instead of
 *    leaving the request (and the user staring at a spinner) hanging indefinitely.
 *
 * Both are exercised against a mocked `@aws-sdk/client-s3` and a mocked `lib/config` (this test
 * env has no real S3 credentials) — no real network call, no real R2 bucket needed.
 */
const sendMock = vi.fn();
let capturedClientConfig: Record<string, unknown> | null = null;

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = sendMock;
    constructor(cfg: Record<string, unknown>) {
      capturedClientConfig = cfg;
    }
  }
  class PutObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});

vi.mock('../../src/lib/config', () => ({
  config: {
    NODE_ENV: 'production',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key-id',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
    S3_REGION: 'auto',
    S3_PUBLIC_URL: 'https://pub-test.r2.dev',
  },
  s3Configured: true,
  PUBLIC_API_URL: 'https://api.test.invalid',
}));

describe('mediaStorage: S3 client configuration', () => {
  beforeEach(() => {
    capturedClientConfig = null;
    sendMock.mockReset();
    vi.resetModules();
  });

  test('constructs the S3 client with forcePathStyle enabled — required for R2, not optional', async () => {
    await import('../../src/lib/mediaStorage');
    expect(capturedClientConfig).toMatchObject({ forcePathStyle: true });
  });
});

describe('mediaStorage: upload timeout', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('an upload that never resolves fails with a clear, retriable error instead of hanging forever', async () => {
    vi.useFakeTimers();
    sendMock.mockImplementation(() => new Promise(() => {})); // never resolves — a genuinely stalled request
    const { saveUpload, MediaStorageUnavailableError } = await import('../../src/lib/mediaStorage');

    const result = saveUpload({ buffer: Buffer.from('fake-image-bytes'), mimeType: 'image/jpeg', kind: 'avatar' });
    const assertion = expect(result).rejects.toBeInstanceOf(MediaStorageUnavailableError);
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });

  test('a normal, fast upload is unaffected by the timeout', async () => {
    sendMock.mockResolvedValue({});
    const { saveUpload } = await import('../../src/lib/mediaStorage');

    const url = await saveUpload({ buffer: Buffer.from('fake-image-bytes'), mimeType: 'image/png', kind: 'crew' });
    expect(url).toMatch(/^https:\/\/pub-test\.r2\.dev\/crew-.+\.png$/);
  });
});

/**
 * THIRD real, live-reported bug: "Something went wrong." on a real phone photo picked from the
 * library — a phone photo is routinely several MB, easily over the app's own 6MB cap, and
 * @fastify/multipart enforces that cap at the STREAM level (throwing FST_REQ_FILE_TOO_LARGE from
 * inside `file.toBuffer()`) — a genuinely different code path from `saveUpload`'s own byte-length
 * check (services/mediaStorage.ts's own `MAX_BYTES`), which only ever sees a buffer that already
 * made it past the stream. Every route used to call `request.file()`/`file.toBuffer()` OUTSIDE
 * its own try/catch, so that specific error bypassed every one of this app's own clean messages
 * and fell straight through to Fastify's generic 500 handler. readMultipartUpload centralises the
 * read so this translation happens exactly once, for every upload route.
 */
describe('mediaStorage: readMultipartUpload — the real fix for "Something went wrong." on an oversized phone photo', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function fakeRequest(fileImpl: () => Promise<unknown>) {
    return { file: fileImpl } as unknown as import('fastify').FastifyRequest;
  }

  test('a file exceeding the size limit is translated into the app\'s own clean MediaValidationError, not a raw multipart error', async () => {
    const { readMultipartUpload, MediaValidationError } = await import('../../src/lib/mediaStorage');
    const tooLargeError = Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
    const request = fakeRequest(async () => ({
      mimetype: 'image/jpeg',
      toBuffer: async () => { throw tooLargeError; },
    }));

    await expect(readMultipartUpload(request)).rejects.toBeInstanceOf(MediaValidationError);
    await expect(readMultipartUpload(request)).rejects.toThrow('Image must be under 6MB.');
  });

  test('the same translation applies when request.file() itself throws the size error (busboy can throw at either point)', async () => {
    const { readMultipartUpload, MediaValidationError } = await import('../../src/lib/mediaStorage');
    const tooLargeError = Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
    const request = fakeRequest(async () => { throw tooLargeError; });

    await expect(readMultipartUpload(request)).rejects.toBeInstanceOf(MediaValidationError);
  });

  test('a genuinely unexpected multipart failure is rethrown as-is, not mislabelled as a size error', async () => {
    const { readMultipartUpload, MediaValidationError } = await import('../../src/lib/mediaStorage');
    const weirdError = new Error('stream was destroyed');
    const request = fakeRequest(async () => ({
      mimetype: 'image/jpeg',
      toBuffer: async () => { throw weirdError; },
    }));

    const rejection = readMultipartUpload(request).catch((e) => e);
    await expect(rejection).resolves.toBe(weirdError);
    await expect(rejection).resolves.not.toBeInstanceOf(MediaValidationError);
  });

  test('no file provided resolves to null, same as before — never throws for the ordinary "nothing selected" case', async () => {
    const { readMultipartUpload } = await import('../../src/lib/mediaStorage');
    const request = fakeRequest(async () => undefined);
    await expect(readMultipartUpload(request)).resolves.toBeNull();
  });

  test('a normal upload reads through untouched — buffer and mimetype pass through exactly as the file provided them', async () => {
    const { readMultipartUpload } = await import('../../src/lib/mediaStorage');
    const realBuffer = Buffer.from('real-image-bytes');
    const request = fakeRequest(async () => ({ mimetype: 'image/png', toBuffer: async () => realBuffer }));

    await expect(readMultipartUpload(request)).resolves.toEqual({ buffer: realBuffer, mimeType: 'image/png' });
  });
});
