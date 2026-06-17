/**
 * Server-component principal helper.
 *
 * Uses next/headers cookies() to read the session cookie without a Request
 * object — for use in Server Components and layouts (Node runtime only).
 *
 * NEVER import this in Edge runtime code (middleware.ts, Edge route handlers).
 * It pulls in node:crypto transitively via verifySession/getAuthSecret.
 */

import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "./cookie";
import { getAuthSecret } from "./index";
import { verifySession } from "./session";
import type { Principal } from "./index";

/**
 * Resolve the current principal from the session cookie.
 *
 * Returns null when:
 * - the cookie is absent
 * - the token is invalid or expired
 * - RD_SYNC_AUTH_SECRET is not set (auth misconfiguration)
 *
 * Never throws. Logs a console.error when a session token is present but
 * RD_SYNC_AUTH_SECRET is missing, so misconfiguration is visible in server logs.
 */
export async function getCurrentPrincipal(now?: number): Promise<Principal | null> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    try {
      const secret = getAuthSecret();
      return verifySession(token, secret, now ?? Date.now());
    } catch (err) {
      // Only log when we have a token — no-cookie path is unauthenticated by design.
      // This catches getAuthSecret() throwing (missing secret) or verifySession errors.
      if (err instanceof Error && err.message.includes("RD_SYNC_AUTH_SECRET")) {
        console.error(
          "[getCurrentPrincipal] Auth misconfiguration: RD_SYNC_AUTH_SECRET is not set. " +
          "Session cookie was present but cannot be verified. Set the secret to enable login.",
        );
      }
      return null;
    }
  } catch {
    return null;
  }
}
