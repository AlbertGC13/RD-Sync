/** AES-256-GCM reversible encryption for bank credential fields. */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface AesGcmEnvelope {
  keyVersion: number;
  iv: string;
  ciphertext: string;
  tag: string;
}

/**
 * Resolves the 32-byte AES-256 master key for a given version.
 * The resolver must throw on unknown versions; this prevents silent decrypt
 * attempts with stale keys.
 */
export type KeyResolver = (version: number) => Buffer;

const IV_LENGTH_BYTES = 12; // 96 bits — GCM recommended
const TAG_LENGTH_BYTES = 16; // 128 bits — GCM standard
const AES_KEY_LENGTH_BYTES = 32; // 256 bits
const DEFAULT_KEY_VERSION = 1;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Encrypt a plaintext string into an AES-256-GCM envelope.
 * Fresh 96-bit IVs are mandatory for every AES-GCM encryption.
 */
export function encryptCredentialField(
  plaintext: string,
  keyResolver: KeyResolver,
  keyVersion: number = DEFAULT_KEY_VERSION,
): AesGcmEnvelope {
  const key = keyResolver(keyVersion);
  assertAesKeyLength(key);

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = cipher.update(plaintext, "utf8");
  cipher.final();

  const tag = cipher.getAuthTag();

  return {
    keyVersion,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt an AES-256-GCM envelope back to the original plaintext string.
 * Error messages never include plaintext or raw envelope values.
 */
export function decryptCredentialField(
  envelope: AesGcmEnvelope,
  keyResolver: KeyResolver,
): string {
  const key = keyResolver(envelope.keyVersion);
  assertAesKeyLength(key);

  const iv = base64ToBuffer(envelope.iv, "iv");
  const ciphertext = base64ToBuffer(envelope.ciphertext, "ciphertext");
  const tag = base64ToBuffer(envelope.tag, "auth tag");

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(
      `Invalid IV length: expected ${IV_LENGTH_BYTES} bytes, got ${iv.length}`,
    );
  }

  if (tag.length !== TAG_LENGTH_BYTES) {
    throw new Error(
      `Invalid auth tag length: expected ${TAG_LENGTH_BYTES} bytes, got ${tag.length}`,
    );
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    const plaintext = decipher.update(ciphertext, undefined, "utf8");
    decipher.final();
    return plaintext;
  } catch {
    throw new Error("Credential decryption failed — invalid key or tampered data");
  }
}

function assertAesKeyLength(key: Buffer): void {
  if (key.length !== AES_KEY_LENGTH_BYTES) {
    throw new Error(
      `Invalid AES key length: expected ${AES_KEY_LENGTH_BYTES} bytes, got ${key.length}`,
    );
  }
}

function base64ToBuffer(b64: string, fieldName: string): Buffer {
  if (!CANONICAL_BASE64_PATTERN.test(b64)) {
    throw new Error(`Malformed ${fieldName} — invalid base64`);
  }

  const decoded = Buffer.from(b64, "base64");
  if (decoded.toString("base64") !== b64) {
    throw new Error(`Malformed ${fieldName} — invalid base64`);
  }

  return decoded;
}
