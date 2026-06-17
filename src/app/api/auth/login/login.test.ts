/**
 * Tests for createLoginHandler factory.
 *
 * Uses InMemoryUserRepository + a fixed clock + a test secret.
 * Never relies on env vars for the secret.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createLoginHandler } from "./route";
import { InMemoryUserRepository } from "../../../../modules/auth/user-repository";
import { hashPassword } from "../../../../modules/auth/password";
import { verifySession } from "../../../../modules/auth/session";
import { SESSION_COOKIE_NAME } from "../../../../modules/auth/cookie";
import type { UserAccount } from "../../../../modules/auth/user-repository";
import type { RateLimiter } from "../../../../modules/auth/rate-limiter";

// Pass-through rate limiter so existing tests are unaffected by the shared
// module-level bucket state accumulated during other test runs.
const passThroughLimiter: RateLimiter = {
  check: () => ({ allowed: true }),
  recordFailure: () => { /* no-op */ },
};

const TEST_SECRET = "test-secret-for-login-handler-x9z";
const FIXED_NOW = 1_000_000;

// Fixtures are populated in beforeAll so hashPassword (async) can be awaited.
let alice: UserAccount;
let disabledUser: UserAccount;
let noHashUser: UserAccount;
// Deterministic decoy hash for tests — avoids running a real scrypt derivation per test.
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

function makeHandler(users?: UserAccount[]) {
  return createLoginHandler({
    users: new InMemoryUserRepository(users ?? [alice, disabledUser, noHashUser]),
    secret: TEST_SECRET,
    clock: () => FIXED_NOW,
    decoyHash: testDecoyHash,
    // Inject a pass-through limiter and no-op delay so these tests stay
    // isolated from module-level state and run without sleeping.
    rateLimiter: passThroughLimiter,
    delay: () => Promise.resolve(),
    floorMs: 0,
  });
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("createLoginHandler", () => {
  it("returns 200 + Set-Cookie on valid credentials", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "alice@example.com", password: "correct-password" }));

    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toContain(SESSION_COOKIE_NAME);
    expect(cookie).toContain("HttpOnly");

    // Verify the token decodes to the right principal
    const tokenMatch = cookie?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1]!;
    const principal = verifySession(token, TEST_SECRET, FIXED_NOW + 1);
    expect(principal?.id).toBe("u-alice");
    expect(principal?.role).toBe("admin");
  });

  it("returns 401 with generic message on wrong password", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "alice@example.com", password: "wrong-password" }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid email or password");
  });

  it("returns 401 with identical generic message on unknown email", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "unknown@example.com", password: "any" }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid email or password");
  });

  it("returns 401 for a disabled user", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "disabled@example.com", password: "some-password" }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid email or password");
  });

  it("returns 401 for a user with null passwordHash", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "nohash@example.com", password: "any" }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid email or password");
  });

  it("does NOT set a cookie on failed login", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "unknown@example.com", password: "any" }));

    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("returns 401 on malformed JSON body", async () => {
    const handler = makeHandler();
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  it("returns 401 when email or password fields are missing", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "alice@example.com" }));

    expect(res.status).toBe(401);
  });

  it("response body contains { ok: true } on success", async () => {
    const handler = makeHandler();
    const res = await handler(makeRequest({ email: "alice@example.com", password: "correct-password" }));

    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
