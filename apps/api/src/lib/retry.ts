/**
 * Exponential backoff with jitter, used by every provider adapter's network calls. One
 * provider timing out or rate-limiting us must never cascade into a failed sync of everyone
 * else's inventory — see brief §42 "one provider outage must not break Plot."
 */
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export class ProviderTimeoutError extends Error {}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { attempts = 3, baseDelayMs = 250, maxDelayMs = 4000, timeoutMs = 8000 } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = controller.signal.aborted ? new ProviderTimeoutError('Provider request timed out') : err;
      if (attempt === attempts) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
