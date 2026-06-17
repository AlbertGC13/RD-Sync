/**
 * Password hashing and verification using node:crypto scrypt.
 *
 * Stored format: "scrypt:<saltHex>:<hashHex>"
 * Salt: 32 random bytes (64 hex chars)
 * Hash: 64 bytes (128 hex chars)
 *
 * Both hashPassword and verifyPassword are async (use scrypt, not scryptSync)
 * so they do not block the Node.js event loop on login.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 32;
const KEY_LEN = 64;
const PREFIX = "scrypt";

/**
 * Hash a plaintext password using scrypt with a random salt.
 * Returns a stored string in the format "scrypt:<saltHex>:<hashHex>".
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(plain, salt, KEY_LEN) as Buffer;
  return `${PREFIX}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * Returns false (never throws) on malformed input or length mismatch.
 * Uses timingSafeEqual for constant-time comparison.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== PREFIX) return false;

    const [, saltHex, hashHex] = parts;
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, "hex");
    const storedHash = Buffer.from(hashHex, "hex");

    if (salt.length !== SALT_BYTES) return false;
    if (storedHash.length !== KEY_LEN) return false;

    const candidateHash = await scryptAsync(plain, salt, KEY_LEN) as Buffer;

    if (candidateHash.length !== storedHash.length) return false;

    return timingSafeEqual(candidateHash, storedHash);
  } catch {
    return false;
  }
}
