/**
 * Sanitize a ?next= query parameter to prevent open redirect vulnerabilities.
 *
 * Rules:
 * - Must be a non-empty string.
 * - Must start with "/" but NOT with "//".
 * - Must not be an absolute URL (no scheme like "https:").
 *
 * Returns the sanitized path, or "/" when the input fails validation.
 */
export function sanitizeNextParam(value: string | undefined | null): string {
  if (!value || typeof value !== "string") return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  // Catch "javascript:", "data:", "https:", etc.
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(value)) return "/";
  return value;
}
