/**
 * Pure, edge-safe middleware decision function.
 *
 * This module has NO runtime dependencies on Next.js, node:crypto, or any
 * server-side module — it is safe to import in the Edge runtime and to unit
 * test without a Next.js environment.
 */

export type MiddlewareDecision =
  | { type: "next" }
  | { type: "redirect"; location: string }
  | { type: "json401" };

interface MiddlewareInput {
  pathname: string;
  hasSessionCookie: boolean;
}

// Prefixes that require a session cookie to serve a page.
const PROTECTED_PAGE_PREFIXES = ["/admin", "/transactions"] as const;

// Prefixes that require a session cookie to serve an API response.
const PROTECTED_API_PREFIXES = [
  "/api/scrape-runs",
  "/api/transactions",
  "/api/bank-sessions",
] as const;

/**
 * Decide what the middleware should do for a given request.
 *
 * Rules (in order):
 * 1. Protected page → no cookie → redirect to /login?next=<encoded pathname>
 * 2. Protected API  → no cookie → 401 JSON
 * 3. Everything else → next (includes /login, /api/auth/*, /_next, static)
 *
 * Cookie presence is checked here. Actual cryptographic verification happens
 * in the Node runtime (layouts and route handlers).
 */
export function decideMiddleware({
  pathname,
  hasSessionCookie,
}: MiddlewareInput): MiddlewareDecision {
  if (hasSessionCookie) {
    return { type: "next" };
  }

  for (const prefix of PROTECTED_PAGE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return {
        type: "redirect",
        location: `/login?next=${encodeURIComponent(pathname)}`,
      };
    }
  }

  for (const prefix of PROTECTED_API_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { type: "json401" };
    }
  }

  return { type: "next" };
}
