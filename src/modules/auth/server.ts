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
 * Never throws.
 */
export async function getCurrentPrincipal(now?: number): Promise<Principal | null> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    const secret = getAuthSecret();
    return verifySession(token, secret, now ?? Date.now());
  } catch {
    return null;
  }
}
