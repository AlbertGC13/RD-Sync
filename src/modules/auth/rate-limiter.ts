/**
 * IP-based login rate limiter.
 *
 * Keyed by client IP (not by email — keying by email allows an attacker to
 * perform a targeted DoS against a known account). IP-scoped limits are
 * independent of email validity, so a throttled response reveals nothing
 * about whether an email address exists.
 *
 * NOTE: InMemoryRateLimiter is per-process and resets on restart. This is
 * acceptable for the local-first MVP. See docs/runbooks/auth.md for details.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets. Present only when allowed === false. */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  recordFailure(key: string): void;
}

interface BucketState {
  count: number;
  windowResetAtMs: number;
}

export interface InMemoryRateLimiterConfig {
  /** Maximum failed attempts before blocking. Default: 5. */
  maxAttempts?: number;
  /** Sliding window duration in ms. Default: 15 * 60 * 1000 (15 min). */
  windowMs?: number;
  /** Injectable clock (returns current epoch ms). Default: Date.now. */
  clock?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000; // 15 minutes

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(config: InMemoryRateLimiterConfig = {}) {
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = config.clock ?? (() => Date.now());
  }

  check(key: string): RateLimitResult {
    const now = this.clock();
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.windowResetAtMs) {
      return { allowed: true };
    }

    if (bucket.count < this.maxAttempts) {
      return { allowed: true };
    }

    const retryAfterMs = bucket.windowResetAtMs - now;
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1_000);
    return { allowed: false, retryAfterSeconds };
  }

  recordFailure(key: string): void {
    const now = this.clock();
    const existing = this.buckets.get(key);

    if (!existing || now >= existing.windowResetAtMs) {
      // Start a fresh window
      this.buckets.set(key, {
        count: 1,
        windowResetAtMs: now + this.windowMs,
      });
      return;
    }

    this.buckets.set(key, {
      count: existing.count + 1,
      windowResetAtMs: existing.windowResetAtMs,
    });
  }
}
