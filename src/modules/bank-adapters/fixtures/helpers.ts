/**
 * PII / secret patterns that must NEVER appear in fixture data.
 * Excludes transaction-level numbers (confirmation, reference, receipt,
 * transaction IDs) — those are expected in bank transaction data.
 *
 * IMPORTANT: No `/g` flag — `.test()` with global regexes is stateful and
 * nondeterministic across repeated calls on the same input.
 */
const SENSITIVE_PATTERNS = [
  /\bDO\s*[A-Z]{2}\s*\d{2}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/i, // IBANs
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // emails
  /\b(password|passwd|pwd|token|cookie|secret|authorization)\s*[:=]\s*\S+/i, // credentials
  /\b[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+\b/, // names (3+ capitalized words)
  /\b\d{3}-\d{7}-\d\b/, // cédula (XXX-XXXXXXX-X) — also covers RNC with check digit
  /\b[1-9]\d{2}-\d{7}\b/, // RNC (tax ID: NXX-XXXXXXX, no check digit)
  /\b\d{3}[-.]\d{3}[-.]\d{4}\b/, // phone (XXX-XXX-XXXX) — requires separator to avoid matching bare 10-digit numbers
  /\b4\d{3}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Visa PAN
  /\b5[1-5]\d{2}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Mastercard PAN
  /\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/, // Amex PAN
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, // JWT
  /\bBearer\s+[A-Za-z0-9._-]+/i, // Bearer token
  /\bsession_id\s*=\s*\S+/i, // session cookie assignment
] as const;

/** Returns true if the input contains PII or secrets (IBANs, emails, credentials, names, etc.). */
export function containsSensitiveData(input: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(input));
}

/** Normalize whitespace — trim and collapse internal whitespace. */
export function normalizeFixtureText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
