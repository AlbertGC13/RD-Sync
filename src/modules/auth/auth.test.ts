import { describe, expect, it } from "vitest";

import {
  assertCanAccessBankSession,
  canReadTransactions,
  canReviewTransactions,
  requireRole,
  resolvePrincipalFromTrustedHeaders,
} from "./index";

describe("RBAC", () => {
  it("allows viewer read-only transaction visibility", () => {
    const principal = { id: "u-viewer", role: "viewer" as const };

    expect(canReadTransactions(principal)).toBe(true);
    expect(canReviewTransactions(principal)).toBe(false);
    expect(() => assertCanAccessBankSession(principal)).toThrow("Admin role required");
  });

  it("denies unauthenticated users", () => {
    expect(() => requireRole(null, ["viewer"])).toThrow("Authentication required");
  });

  it("resolves trusted internal headers into a principal", () => {
    const headers = new Headers({
      "x-rd-sync-user-id": "admin-1",
      "x-rd-sync-role": "admin",
    });

    expect(resolvePrincipalFromTrustedHeaders(headers)).toEqual({ id: "admin-1", role: "admin" });
  });
});
