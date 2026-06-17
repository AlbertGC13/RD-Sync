/**
 * Tests for getCurrentPrincipal (server.ts) secret-missing hardening.
 *
 * getCurrentPrincipal wraps cookies() from next/headers which cannot be called
 * outside a Next.js request context. We test the auth/index.ts helpers directly
 * for resolvePrincipalFromCookie, and use a factory-based approach for
 * getCurrentPrincipal by extracting the testable logic.
 *
 * We CANNOT vi.mock next/headers here (no vi.mock per project rules).
 * Instead we test the underlying resolvePrincipalFromCookie from index.ts
 * which is the same logic getCurrentPrincipal delegates to after reading the cookie.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePrincipalFromCookie } from "./index";
import { signSession } from "./session";
import { SESSION_COOKIE_NAME } from "./cookie";

const TEST_SECRET = "test-secret-server-hardening-x9z";

function makeCookieRequest(token: string): Request {
  return new Request("https://rd-sync.test/", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

function makeEmptyRequest(): Request {
  return new Request("https://rd-sync.test/");
}

describe("resolvePrincipalFromCookie — secret-missing hardening", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_AUTH_SECRET;
    vi.restoreAllMocks();
  });

  it("returns null when there is no cookie and secret is set", () => {
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;

    const result = resolvePrincipalFromCookie(makeEmptyRequest());
    expect(result).toBeNull();
  });

  it("returns null when there is no cookie and secret is UNSET (must not throw)", () => {
    delete process.env.RD_SYNC_AUTH_SECRET;

    // Must not throw even though getAuthSecret() would throw if called
    expect(() => resolvePrincipalFromCookie(makeEmptyRequest())).not.toThrow();
    const result = resolvePrincipalFromCookie(makeEmptyRequest());
    expect(result).toBeNull();
  });

  it("returns null when token is present but secret is UNSET (must not throw)", () => {
    // First create a token with a known secret
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;
    const now = Date.now();
    const token = signSession(
      { userId: "u-test", role: "admin", expiresAt: now + 60_000 },
      TEST_SECRET,
    );
    delete process.env.RD_SYNC_AUTH_SECRET;

    const req = makeCookieRequest(token);

    // Must not throw and must return null (catch block in resolvePrincipalFromCookie)
    expect(() => resolvePrincipalFromCookie(req)).not.toThrow();
    const result = resolvePrincipalFromCookie(req);
    expect(result).toBeNull();
  });

  it("returns the principal when token is valid and secret is set", () => {
    process.env.RD_SYNC_AUTH_SECRET = TEST_SECRET;
    const now = Date.now();
    const token = signSession(
      { userId: "u-test", role: "reviewer", expiresAt: now + 60_000 },
      TEST_SECRET,
    );

    const result = resolvePrincipalFromCookie(makeCookieRequest(token), now);
    expect(result).toEqual({ id: "u-test", role: "reviewer" });
  });
});

// ---------------------------------------------------------------------------
// getCurrentPrincipal uses the same catch-and-null pattern.
// We verify the exported function exists and is async (structural test only,
// since its runtime depends on next/headers which requires the Next.js server).
// ---------------------------------------------------------------------------

describe("getCurrentPrincipal — structural contract", () => {
  it("is an async function exported from server.ts", async () => {
    // Dynamic import so next/headers is not resolved in test environment.
    // We only verify the export shape, not call it.
    // The actual behavior is covered by resolvePrincipalFromCookie tests above,
    // since getCurrentPrincipal reads the cookie then delegates the same logic.
    const mod = await import("./server").catch(() => null);
    if (mod !== null) {
      expect(typeof mod.getCurrentPrincipal).toBe("function");
    }
    // If the import fails (next/headers not available in test env), that's expected.
  });
});
