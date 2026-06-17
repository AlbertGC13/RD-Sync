/**
 * Stateless signed session tokens.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 *
 * IMPORTANT: node:crypto is used here — this module must NEVER run on the
 * Next.js Edge runtime. Keep it in Node runtime (layouts, route handlers).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal, Role } from "./index";

export interface SessionPayload {
  userId: string;
  role: Role;
  expiresAt: number; // Unix ms
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function toBase64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function hmacPart(payloadPart: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Returns the raw 32-byte HMAC-SHA256 digest for constant-time comparison. */
function hmacDigest(payloadPart: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadPart).digest();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a signed session token.
 * @param payload - Session payload including userId, role, and expiresAt (Unix ms).
 * @param secret - HMAC secret (read from env at call time, not at import time).
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const payloadPart = toBase64url(JSON.stringify(payload));
  const sig = hmacPart(payloadPart, secret);
  return `${payloadPart}.${sig}`;
}

/**
 * Verify and decode a session token.
 * Returns a Principal on success or null on any failure.
 * NEVER throws — all errors are caught and return null.
 *
 * @param token - The raw token string from the cookie.
 * @param secret - HMAC secret.
 * @param now - Current time in Unix ms (injected for deterministic testing).
 */
export function verifySession(token: string, secret: string, now: number): Principal | null {
  try {
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex <= 0) return null;

    const payloadPart = token.slice(0, dotIndex);
    const receivedSig = token.slice(dotIndex + 1);

    if (!payloadPart || !receivedSig) return null;

    // Recompute HMAC and compare raw digest bytes with constant-time equality.
    // Comparing 32 raw bytes (not base64url strings) is the idiomatic approach
    // and avoids any alphabet-level timing signals.
    const expectedBuf = hmacDigest(payloadPart, secret);
    const receivedBuf = Buffer.from(receivedSig, "base64url");

    if (expectedBuf.length !== receivedBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, receivedBuf)) return null;

    // Parse payload
    const rawJson = fromBase64url(payloadPart);
    const payload = JSON.parse(rawJson) as unknown;

    if (!isSessionPayload(payload)) return null;

    // Check expiry
    if (payload.expiresAt <= now) return null;

    return { id: payload.userId, role: payload.role };
  } catch {
    return null;
  }
}

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "reviewer" || value === "viewer";
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.userId === "string" &&
    isRole(obj.role) &&
    typeof obj.expiresAt === "number"
  );
}
