/**
 * Tests for InMemoryRateLimiter.
 *
 * Uses an injected clock so tests are fully deterministic (no real timers).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRateLimiter } from "./rate-limiter";

describe("InMemoryRateLimiter", () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 0;
  });

  it("allows requests below the limit", () => {
    const limiter = new InMemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000, clock });

    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");

    const result = limiter.check("ip1");
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it("blocks after maxAttempts failures", () => {
    const limiter = new InMemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000, clock });

    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");

    const result = limiter.check("ip1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("returns correct retryAfterSeconds", () => {
    const windowMs = 60_000;
    const limiter = new InMemoryRateLimiter({ maxAttempts: 2, windowMs, clock });

    now = 10_000;
    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");

    // window resets at now + windowMs = 10_000 + 60_000 = 70_000
    // retryAfterSeconds = ceil((70_000 - now) / 1000) = ceil(60_000 / 1000) = 60
    const result = limiter.check("ip1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("allows requests again after window expires", () => {
    const windowMs = 60_000;
    const limiter = new InMemoryRateLimiter({ maxAttempts: 2, windowMs, clock });

    now = 0;
    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");

    expect(limiter.check("ip1").allowed).toBe(false);

    // Advance past window
    now = windowMs + 1;

    const result = limiter.check("ip1");
    expect(result.allowed).toBe(true);
  });

  it("tracks different keys independently", () => {
    const limiter = new InMemoryRateLimiter({ maxAttempts: 2, windowMs: 60_000, clock });

    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");

    expect(limiter.check("ip1").allowed).toBe(false);
    expect(limiter.check("ip2").allowed).toBe(true);
  });

  it("returns allowed:true and no retryAfterSeconds for clean key", () => {
    const limiter = new InMemoryRateLimiter({ maxAttempts: 5, windowMs: 60_000, clock });

    const result = limiter.check("fresh-ip");
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it("uses default maxAttempts=5 and windowMs=15min when no config provided", () => {
    const limiter = new InMemoryRateLimiter({ clock });

    for (let i = 0; i < 5; i++) {
      limiter.recordFailure("ip1");
    }

    expect(limiter.check("ip1").allowed).toBe(false);
    // retryAfterSeconds should be around 900 (15 min)
    const result = limiter.check("ip1");
    expect(result.retryAfterSeconds).toBe(900);
  });

  it("resets window count when window expires mid-stream", () => {
    const windowMs = 30_000;
    const limiter = new InMemoryRateLimiter({ maxAttempts: 3, windowMs, clock });

    now = 0;
    limiter.recordFailure("ip1");
    limiter.recordFailure("ip1");

    // Advance into a new window
    now = windowMs + 1;
    // First failure in new window — should not be blocked
    limiter.recordFailure("ip1");

    expect(limiter.check("ip1").allowed).toBe(true);
  });
});
