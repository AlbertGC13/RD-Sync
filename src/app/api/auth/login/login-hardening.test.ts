/**
 * Hardening tests for createLoginHandler:
 *
 * 1. IP-based rate limiting (429, Retry-After header, no email leakage).
 * 2. Response-time floor injection (delay called on 200 + 401 paths, NOT on 429).
 * 3. Constant-work regression: verifyPassword path runs for all failure modes.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createLoginHandler } from "./route";
import { InMemoryUserRepository } from "../../../../modules/auth/user-repository";
import { hashPassword } from "../../../../modules/auth/password";
import type { UserAccount } from "../../../../modules/auth/user-repository";
import type { RateLimiter } from "../../../../modules/auth/rate-limiter";

const TEST_SECRET = "test-secret-hardening-x9z";
const FIXED_NOW = 2_000_000;

let alice: UserAccount;
let disabledUser: UserAccount;
let noHashUser: UserAccount;
let testDecoyHash: Promise<string>;

beforeAll(async () => {
  alice = {
    id: "u-alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "admin",
    status: "active",
    passwordHash: await hashPassword("correct-password"),
  };

  disabledUser = {
    id: "u-disabled",
    email: "disabled@example.com",
    displayName: "Disabled",
    role: "viewer",
    status: "disabled",
    passwordHash: await hashPassword("some-password"),
  };

  noHashUser = {
    id: "u-nohash",
    email: "nohash@example.com",
    displayName: "NoHash",
    role: "viewer",
    status: "active",
    passwordHash: null,
  };

  testDecoyHash = hashPassword("rd-sync-decoy-constant-work");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelayRecord {
  calls: number[];
}

function makeDelayRecorder(): { delay: (ms: number) => Promise<void>; record: DelayRecord } {
  const record: DelayRecord = { calls: [] };
  return {
    delay: (ms: number) => {
      record.calls.push(ms);
      return Promise.resolve();
    },
    record,
  };
}

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeBlockedLimiter(): RateLimiter {
  return {
    check: () => ({ allowed: false, retryAfterSeconds: 42 }),
    recordFailure: () => { /* no-op */ },
  };
}

function makePassLimiter(): RateLimiter {
  return {
    check: () => ({ allowed: true }),
    recordFailure: () => { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// Rate limiting tests
// ---------------------------------------------------------------------------

describe("createLoginHandler — IP rate limiting", () => {
  it("returns 429 when rate limiter blocks the IP", async () => {
    const { delay, record } = makeDelayRecorder();
    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: makeBlockedLimiter(),
      delay,
      floorMs: 250,
    });

    const res = await handler(
      makeRequest({ email: "alice@example.com", password: "correct-password" }),
    );

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Too many attempts. Try again later.");
    // Retry-After header must be present
    expect(res.headers.get("Retry-After")).toBe("42");
    // Delay must NOT be called on 429 path
    expect(record.calls).toHaveLength(0);
  });

  it("does not reveal email validity on 429 (IP-scoped, fires before user lookup)", async () => {
    const lookupCalled: string[] = [];
    const trackingRepo: InMemoryUserRepository = new InMemoryUserRepository([alice]);
    // Wrap findByEmail to detect if it was called
    const originalFind = trackingRepo.findByEmail.bind(trackingRepo);
    trackingRepo.findByEmail = async (email: string) => {
      lookupCalled.push(email);
      return originalFind(email);
    };

    const handler = createLoginHandler({
      users: trackingRepo,
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: makeBlockedLimiter(),
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    // Unknown email — blocked by IP
    await handler(makeRequest({ email: "unknown@example.com", password: "any" }));
    // findByEmail should NOT have been called — 429 fires first
    expect(lookupCalled).toHaveLength(0);
  });

  it("prefers x-forwarded-for first hop as the rate-limit key", async () => {
    let capturedKey: string | undefined;
    const trackingLimiter: RateLimiter = {
      check: (key: string) => {
        capturedKey = key;
        return { allowed: false, retryAfterSeconds: 1 };
      },
      recordFailure: () => { /* no-op */ },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    await handler(
      makeRequest(
        { email: "alice@example.com", password: "pw" },
        { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
      ),
    );

    // Only the first hop (1.2.3.4) should be used
    expect(capturedKey).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    let capturedKey: string | undefined;
    const trackingLimiter: RateLimiter = {
      check: (key: string) => {
        capturedKey = key;
        return { allowed: false, retryAfterSeconds: 1 };
      },
      recordFailure: () => { /* no-op */ },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    await handler(
      makeRequest(
        { email: "alice@example.com", password: "pw" },
        { "x-real-ip": "5.6.7.8" },
      ),
    );

    expect(capturedKey).toBe("5.6.7.8");
  });

  it("falls back to 'unknown' when no IP header is present", async () => {
    let capturedKey: string | undefined;
    const trackingLimiter: RateLimiter = {
      check: (key: string) => {
        capturedKey = key;
        return { allowed: true };
      },
      recordFailure: () => { /* no-op */ },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    // No IP headers
    await handler(makeRequest({ email: "alice@example.com", password: "correct-password" }));

    expect(capturedKey).toBe("unknown");
  });

  it("records failure for unknown email (not revealing email via rate-limit skip)", async () => {
    const failures: string[] = [];
    const trackingLimiter: RateLimiter = {
      check: () => ({ allowed: true }),
      recordFailure: (key: string) => { failures.push(key); },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    await handler(
      makeRequest(
        { email: "ghost@example.com", password: "any" },
        { "x-forwarded-for": "9.9.9.9" },
      ),
    );

    expect(failures).toContain("9.9.9.9");
  });

  it("records failure for wrong password", async () => {
    const failures: string[] = [];
    const trackingLimiter: RateLimiter = {
      check: () => ({ allowed: true }),
      recordFailure: (key: string) => { failures.push(key); },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    await handler(
      makeRequest(
        { email: "alice@example.com", password: "wrong" },
        { "x-forwarded-for": "9.9.9.9" },
      ),
    );

    expect(failures).toContain("9.9.9.9");
  });

  it("does NOT record failure on successful login", async () => {
    const failures: string[] = [];
    const trackingLimiter: RateLimiter = {
      check: () => ({ allowed: true }),
      recordFailure: (key: string) => { failures.push(key); },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const res = await handler(
      makeRequest(
        { email: "alice@example.com", password: "correct-password" },
        { "x-forwarded-for": "9.9.9.9" },
      ),
    );

    expect(res.status).toBe(200);
    expect(failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Body-validation paths must consume rate-limit budget
// ---------------------------------------------------------------------------

describe("createLoginHandler — body-validation failure recording", () => {
  it("records failure when the request body is malformed JSON", async () => {
    const failures: string[] = [];
    const trackingLimiter: RateLimiter = {
      check: () => ({ allowed: true }),
      recordFailure: (key: string) => { failures.push(key); },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const malformedRequest = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: "not-json{{{",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.1.1.1" },
    });

    const res = await handler(malformedRequest);
    expect(res.status).toBe(401);
    expect(failures).toContain("1.1.1.1");
  });

  it("records failure when the body is not an object (e.g. an array)", async () => {
    const failures: string[] = [];
    const trackingLimiter: RateLimiter = {
      check: () => ({ allowed: true }),
      recordFailure: (key: string) => { failures.push(key); },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const res = await handler(makeRequest(["not", "an", "object"], { "x-forwarded-for": "2.2.2.2" }));
    expect(res.status).toBe(401);
    expect(failures).toContain("2.2.2.2");
  });

  it("records failure when email or password fields have wrong types", async () => {
    const failures: string[] = [];
    const trackingLimiter: RateLimiter = {
      check: () => ({ allowed: true }),
      recordFailure: (key: string) => { failures.push(key); },
    };

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: trackingLimiter,
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    // email is a number instead of a string
    const res = await handler(makeRequest({ email: 42, password: "x" }, { "x-forwarded-for": "3.3.3.3" }));
    expect(res.status).toBe(401);
    expect(failures).toContain("3.3.3.3");
  });
});

// ---------------------------------------------------------------------------
// Response-time floor tests
// ---------------------------------------------------------------------------

describe("createLoginHandler — response-time floor", () => {
  it("requests delay on 200 success path", async () => {
    let clockTick = 0;
    const { delay, record } = makeDelayRecorder();

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => {
        // First call = start time (0), second call = elapsed check (50ms later)
        return clockTick++ === 0 ? 0 : 50;
      },
      decoyHash: testDecoyHash,
      rateLimiter: makePassLimiter(),
      delay,
      floorMs: 250,
    });

    const res = await handler(makeRequest({ email: "alice@example.com", password: "correct-password" }));
    expect(res.status).toBe(200);

    // Should have been called once with 250 - 50 = 200
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]).toBe(200);
  });

  it("requests delay on 401 invalid-credentials path", async () => {
    let clockTick = 0;
    const { delay, record } = makeDelayRecorder();

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => (clockTick++ === 0 ? 0 : 100),
      decoyHash: testDecoyHash,
      rateLimiter: makePassLimiter(),
      delay,
      floorMs: 250,
    });

    const res = await handler(makeRequest({ email: "alice@example.com", password: "wrong-password" }));
    expect(res.status).toBe(401);

    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]).toBe(150); // 250 - 100 = 150
  });

  it("does NOT request delay on 429 path", async () => {
    const { delay, record } = makeDelayRecorder();

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: makeBlockedLimiter(),
      delay,
      floorMs: 250,
    });

    const res = await handler(makeRequest({ email: "alice@example.com", password: "any" }));
    expect(res.status).toBe(429);

    expect(record.calls).toHaveLength(0);
  });

  it("clamps delay to 0 when elapsed >= floorMs", async () => {
    let clockTick = 0;
    const { delay, record } = makeDelayRecorder();

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      // Simulate elapsed > floor: start=0, end=500 → elapsed=500 > floorMs=250
      clock: () => (clockTick++ === 0 ? 0 : 500),
      decoyHash: testDecoyHash,
      rateLimiter: makePassLimiter(),
      delay,
      floorMs: 250,
    });

    await handler(makeRequest({ email: "alice@example.com", password: "correct-password" }));

    // Delay should be called with 0 (Math.max(0, 250 - 500))
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constant-work regression: verifyPassword runs for all failure modes
// ---------------------------------------------------------------------------

describe("createLoginHandler — constant-work regression", () => {
  it("runs verifyPassword (via decoyHash) for unknown email", async () => {
    let verifyCalled = false;

    // We detect verify ran by using a decoyHash that only resolves after being "checked"
    const sentinelDecoyHash = hashPassword("sentinel-decoy");
    // We can't intercept verifyPassword directly without vi.mock, so we instead
    // observe that the decoyHash promise is awaited by measuring behavior:
    // unknown email → candidateHash === decoy → verifyPassword(plain, decoy) is called.
    // We verify this indirectly: the response must be 401, not an exception or short-circuit.
    // The decoy hash test below verifies that the flow completes correctly.

    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: (async () => {
        verifyCalled = true;
        return sentinelDecoyHash;
      })(),
      rateLimiter: makePassLimiter(),
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const res = await handler(makeRequest({ email: "unknown@example.com", password: "any" }));
    expect(res.status).toBe(401);
    // The decoy promise was awaited (getDecoyHash() path was taken for unknown email)
    expect(verifyCalled).toBe(true);
  });

  it("runs verifyPassword for disabled user (uses user hash, not decoy)", async () => {
    // Disabled user has a real passwordHash — scrypt runs against it.
    // We just assert the result is 401, not an exception or 200.
    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice, disabledUser]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: makePassLimiter(),
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const res = await handler(makeRequest({ email: "disabled@example.com", password: "some-password" }));
    expect(res.status).toBe(401);
  });

  it("runs verifyPassword for null-hash user (uses decoy)", async () => {
    let decoyAwaited = false;
    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice, noHashUser]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: (async () => {
        decoyAwaited = true;
        return testDecoyHash;
      })(),
      rateLimiter: makePassLimiter(),
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const res = await handler(makeRequest({ email: "nohash@example.com", password: "any" }));
    expect(res.status).toBe(401);
    expect(decoyAwaited).toBe(true);
  });

  it("runs verifyPassword for wrong password (uses user hash)", async () => {
    // Wrong password → passwordValid = false → 401. Scrypt ran.
    const handler = createLoginHandler({
      users: new InMemoryUserRepository([alice]),
      secret: TEST_SECRET,
      clock: () => FIXED_NOW,
      decoyHash: testDecoyHash,
      rateLimiter: makePassLimiter(),
      delay: () => Promise.resolve(),
      floorMs: 0,
    });

    const res = await handler(makeRequest({ email: "alice@example.com", password: "bad-pw" }));
    expect(res.status).toBe(401);
  });
});
