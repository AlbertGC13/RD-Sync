/**
 * Sanitize a ?next= query parameter to prevent open redirect vulnerabilities.
 *
 * Rules:
 * - Must be a non-empty string.
 * - Must start with "/" but NOT with "//".
 * - Must not be an absolute URL (no scheme like "https:").
 * - Must not contain raw C0 control characters (U+0000-U+001F) or DEL (U+007F).
 *   Percent-encoded representations (e.g. %00) are allowed - only raw bytes blocked.
 *
 * Returns the sanitized path, or "/" when the input fails validation.
 */
export function sanitizeNextParam(value: string | undefined | null): string {
  if (!value || typeof value !== "string") return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  // Catch "javascript:", "data:", "https:", etc.
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(value)) return "/";
  // Reject raw C0 control characters (U+0000-U+001F) and DEL (U+007F).
  // These can be used for header injection or log poisoning.
  // Note: percent-encoded chars like %00 are NOT rejected - only raw bytes.
  if (/[\x00-\x1f\x7f]/.test(value)) return "/";
  return value;
}
