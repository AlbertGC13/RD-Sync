/**
 * Security tests for resolvePrincipal.
 *
 * Verifies that:
 * 1. Trusted proxy headers are IGNORED unless RD_SYNC_TRUST_PROXY_HEADERS="enabled".
 * 2. A valid signed cookie resolves regardless of the flag.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePrincipal } from "./index";
import { signSession } from "./session";
import { SESSION_COOKIE_NAME } from "./cookie";

// A fixed secret used only for these tests.
const TEST_SECRET = "test-secret-for-resolve-principal-tests";

// Build a request carrying trusted proxy headers but NO cookie.
function makeHeaderOnlyRequest(): Request {
  return new Request("https://rd-sync.test/api/transactions", {
    headers: {
      "x-rd-sync-user-id": "user-from-header",
      "x-rd-sync-role": "admin",
    },
  });
}

// Build a request carrying a valid signed session cookie.
function makeCookieRequest(now: number): Request {
  const token = signSession(
    { userId: "user-from-cookie", role: "reviewer", expiresAt: now + 60_000 },
    TEST_SECRET,
  );
  return new Request("https://rd-sync.test/api/transactions", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
  });
}

describe("resolvePrincipal — proxy header trust", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    delete process.env.RD_SYNC_AUTH_SECRET;
  });

  it("does NOT resolve principal from trusted headers when flag is unset", () => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    // No auth secret needed — cookie path short-circuits before headers
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;

    const request = makeHeaderOnlyRequest();
    const principal = resolvePrincipal(request);

    expect(principal).toBeNull();
  });

  it("does NOT resolve principal from trusted headers when flag is set to something other than 'enabled'", () => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "true";
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;

    const request = makeHeaderOnlyRequest();
    const principal = resolvePrincipal(request);

    expect(principal).toBeNull();
  });

  it("resolves principal from trusted headers when flag is 'enabled'", () => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;

    const request = makeHeaderOnlyRequest();
    const principal = resolvePrincipal(request);

    expect(principal).toEqual({ id: "user-from-header", role: "admin" });
  });
});

describe("resolvePrincipal — cookie auth", () => {
  beforeEach(() => {
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.RD_SYNC_AUTH_SECRET;
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("resolves principal from a valid signed cookie when flag is unset", () => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    const now = Date.now();
    const request = makeCookieRequest(now);

    const principal = resolvePrincipal(request, now);

    expect(principal).toEqual({ id: "user-from-cookie", role: "reviewer" });
  });

  it("resolves principal from a valid signed cookie even when flag is 'enabled'", () => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
    const now = Date.now();
    const request = makeCookieRequest(now);

    const principal = resolvePrincipal(request, now);

    expect(principal).toEqual({ id: "user-from-cookie", role: "reviewer" });
  });
});
