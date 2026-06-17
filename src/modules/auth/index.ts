import { readSessionTokenFromHeaders } from "./cookie";
import { verifySession } from "./session";

export type Role = "admin" | "reviewer" | "viewer";

export interface Principal {
  id: string;
  role: Role;
}

const roleRank: Record<Role, number> = {
  viewer: 1,
  reviewer: 2,
  admin: 3,
};

// ---------------------------------------------------------------------------
// Auth secret — fail-fast at call time (never at module top-level)
// ---------------------------------------------------------------------------

/**
 * Returns RD_SYNC_AUTH_SECRET from the environment.
 * Throws a clear error if missing or empty — fail-fast, never silent.
 * Read at CALL TIME so the module is always safe to import.
 */
export function getAuthSecret(): string {
  const secret = process.env.RD_SYNC_AUTH_SECRET;
  if (!secret || secret.trim() === "") {
    throw new Error(
      "RD_SYNC_AUTH_SECRET is not set. Set a strong random secret to enable session signing.",
    );
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Principal resolution — cookie session first, trusted headers as fallback
// ---------------------------------------------------------------------------

/**
 * Resolve a Principal from a signed session cookie in the request.
 * Returns null if the cookie is absent, invalid, or expired.
 *
 * NOTE: This function uses node:crypto (via verifySession) and must only run
 * in the Node.js runtime (layouts, route handlers) — NEVER in Edge middleware.
 */
export function resolvePrincipalFromCookie(request: Request, now?: number): Principal | null {
  const token = readSessionTokenFromHeaders(request.headers);
  if (!token) return null;
  try {
    const secret = getAuthSecret();
    return verifySession(token, secret, now ?? Date.now());
  } catch {
    return null;
  }
}

/**
 * Resolve a Principal from the incoming request.
 *
 * Resolution order:
 * 1. Signed session cookie (always checked, Node runtime only).
 * 2. Trusted proxy headers — ONLY when RD_SYNC_TRUST_PROXY_HEADERS === "enabled".
 *    Default is OFF; unsigned headers are never trusted in production.
 */
export function resolvePrincipal(request: Request, now?: number): Principal | null {
  const fromCookie = resolvePrincipalFromCookie(request, now);
  if (fromCookie) return fromCookie;

  if (process.env.RD_SYNC_TRUST_PROXY_HEADERS === "enabled") {
    return resolvePrincipalFromTrustedHeaders(request.headers);
  }

  return null;
}

/**
 * Resolve principal from trusted HTTP headers.
 * These headers are ONLY trusted when RD_SYNC_TRUST_PROXY_HEADERS=enabled.
 * Call resolvePrincipal() instead of this function directly in most cases.
 */
export function resolvePrincipalFromTrustedHeaders(headers: Headers): Principal | null {
  const id = headers.get("x-rd-sync-user-id")?.trim();
  const role = headers.get("x-rd-sync-role")?.trim().toLowerCase();

  if (!id || !isRole(role)) return null;

  return { id, role };
}

export function requireRole(principal: Principal | null, allowedRoles: readonly Role[]): Principal {
  if (!principal) {
    throw new Error("Authentication required");
  }

  if (!allowedRoles.includes(principal.role)) {
    throw new Error(`Role ${principal.role} is not allowed`);
  }

  return principal;
}

export function canReadTransactions(principal: Principal | null): boolean {
  return hasAtLeastRole(principal, "viewer");
}

export function canReviewTransactions(principal: Principal | null): boolean {
  return hasAtLeastRole(principal, "reviewer");
}

export function assertCanAccessBankSession(principal: Principal | null): Principal {
  if (!principal || !hasAtLeastRole(principal, "admin")) {
    throw new Error("Admin role required");
  }

  return principal;
}

export function hasAtLeastRole(principal: Principal | null, minimumRole: Role): boolean {
  if (!principal) return false;
  return roleRank[principal.role] >= roleRank[minimumRole];
}

function isRole(value: string | undefined): value is Role {
  return value === "admin" || value === "reviewer" || value === "viewer";
}
