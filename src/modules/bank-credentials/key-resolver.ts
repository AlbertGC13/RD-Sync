const AES_KEY_LENGTH_BYTES = 32;
const BASE64_KEY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CANONICAL_32_BYTE_BASE64_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

function assertSupportedVersion(version: number): void {
  if (version !== 1) {
    throw new Error(`Unsupported key version: ${version}. Only version 1 is currently supported.`);
  }
}

export function createCredentialKeyResolver(encodedKey: string): (version?: number) => Buffer {
  validateEncodedKey(encodedKey);

  return (version: number = 1): Buffer => {
    assertSupportedVersion(version);
    const key = decodeKey(encodedKey);
    if (key.length !== AES_KEY_LENGTH_BYTES) throw new Error(`RD_SYNC_BANK_CREDENTIAL_KEY decoded to ${key.length} bytes, expected ${AES_KEY_LENGTH_BYTES}.`);
    return key;
  };
}

export function resolveCredentialKey(version: number = 1): Buffer {
  assertSupportedVersion(version);

  const raw = process.env.RD_SYNC_BANK_CREDENTIAL_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "RD_SYNC_BANK_CREDENTIAL_KEY is not set. " +
        "Set a 32-byte key encoded as base64 or hex in the environment.",
    );
  }

  return createCredentialKeyResolver(raw.trim())(version);
}

function decodeKey(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  if (/^[A-Za-z0-9+/]+=*$/.test(value)) {
    const buf = Buffer.from(value, "base64");
    if (buf.toString("base64") === value) {
      return buf;
    }
  }

  throw new Error(
    "RD_SYNC_BANK_CREDENTIAL_KEY is not valid base64 or hex. " +
      "Expected a base64-encoded 32-byte key or a 64-char hex string.",
  );
}

function validateEncodedKey(value: string): void {
  if (/^[0-9a-fA-F]{64}$/.test(value) || CANONICAL_32_BYTE_BASE64_RE.test(value)) return;
  if (BASE64_KEY_RE.test(value) && value.length % 4 === 0) {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const length = value.length / 4 * 3 - padding;
    if (length !== AES_KEY_LENGTH_BYTES) throw new Error(`RD_SYNC_BANK_CREDENTIAL_KEY decoded to ${length} bytes, expected ${AES_KEY_LENGTH_BYTES}.`);
  }
  throw new Error(
    "RD_SYNC_BANK_CREDENTIAL_KEY is not valid base64 or hex. " +
      "Expected a base64-encoded 32-byte key or a 64-char hex string.",
  );
}
