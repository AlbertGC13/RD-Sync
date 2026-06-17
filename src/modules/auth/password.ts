/**
 * Password hashing and verification using node:crypto scrypt.
 *
 * Stored format: "scrypt:<saltHex>:<hashHex>"
 * Salt: 32 random bytes (64 hex chars)
 * Hash: 64 bytes (128 hex chars)
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 32;
const KEY_LEN = 64;
const PREFIX = "scrypt";

/**
 * Hash a plaintext password using scrypt with a random salt.
 * Returns a stored string in the format "scrypt:<saltHex>:<hashHex>".
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_LEN);
  return `${PREFIX}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * Returns false (never throws) on malformed input or length mismatch.
 * Uses timingSafeEqual for constant-time comparison.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== PREFIX) return false;

    const [, saltHex, hashHex] = parts;
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, "hex");
    const storedHash = Buffer.from(hashHex, "hex");

    if (salt.length !== SALT_BYTES) return false;
    if (storedHash.length !== KEY_LEN) return false;

    const candidateHash = scryptSync(plain, salt, KEY_LEN);

    if (candidateHash.length !== storedHash.length) return false;

    return timingSafeEqual(candidateHash, storedHash);
  } catch {
    return false;
  }
}
