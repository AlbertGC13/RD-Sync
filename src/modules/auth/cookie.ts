/**
 * Session cookie constants and helpers.
 *
 * Cookie attributes:
 * - httpOnly: true  (not accessible from JS)
 * - sameSite: lax   (CSRF protection for top-level navigation)
 * - secure: true in production
 * - path: "/"
 * - maxAge: 8 hours default session lifetime
 */

export const SESSION_COOKIE_NAME = "rd_sync_session";

/** Session lifetime: 8 hours in seconds */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Session lifetime in milliseconds (for token expiry calculation) */
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

/**
 * Build Set-Cookie options for the session cookie.
 */
export function buildSessionCookieOptions(
  overrides: { maxAge?: number; secure?: boolean } = {},
): {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: overrides.secure ?? isProduction,
    path: "/",
    maxAge: overrides.maxAge ?? SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Read the session token from a Headers object (looks for the cookie header).
 */
export function readSessionTokenFromHeaders(headers: Headers): string | null {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  return parseSessionCookie(cookieHeader);
}

/**
 * Parse the session token value from a raw Cookie header string.
 */
export function parseSessionCookie(cookieHeader: string): string | null {
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const eqIndex = cookie.indexOf("=");
    if (eqIndex === -1) continue;
    const name = cookie.slice(0, eqIndex).trim();
    if (name === SESSION_COOKIE_NAME) {
      return cookie.slice(eqIndex + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Serialize a Set-Cookie header value for the session cookie.
 */
export function serializeSessionCookie(
  token: string,
  options: ReturnType<typeof buildSessionCookieOptions>,
): string {
  const parts = [`${SESSION_COOKIE_NAME}=${token}`];
  parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

/**
 * Serialize a Set-Cookie header value that clears the session cookie.
 */
export function serializeClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=lax`;
}
