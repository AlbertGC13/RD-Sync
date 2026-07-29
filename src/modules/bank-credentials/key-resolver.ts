const AES_KEY_LENGTH_BYTES = 32;

export function resolveCredentialKey(version: number = 1): Buffer {
  if (version !== 1) {
    throw new Error(`Unsupported key version: ${version}. Only version 1 is currently supported.`);
  }

  const raw = process.env.RD_SYNC_BANK_CREDENTIAL_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "RD_SYNC_BANK_CREDENTIAL_KEY is not set. " +
        "Set a 32-byte key encoded as base64 or hex in the environment.",
    );
  }

  const key = decodeKey(raw.trim());
  if (key.length !== AES_KEY_LENGTH_BYTES) {
    throw new Error(
      `RD_SYNC_BANK_CREDENTIAL_KEY decoded to ${key.length} bytes, expected ${AES_KEY_LENGTH_BYTES}.`,
    );
  }

  return key;
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
