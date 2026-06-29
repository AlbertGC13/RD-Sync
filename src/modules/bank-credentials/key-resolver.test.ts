import { afterEach, describe, expect, it } from "vitest";
import { resolveCredentialKey } from "./key-resolver";

const ENV_KEY = "RD_SYNC_BANK_CREDENTIAL_KEY";
const key32 = Buffer.alloc(32, 0x42);

describe("resolveCredentialKey", () => {
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it.each([
    ["base64", key32.toString("base64"), key32],
    ["hex", Buffer.alloc(32, 0xab).toString("hex"), Buffer.alloc(32, 0xab)],
  ])("resolves a %s key", (_label, value, expected) => {
    process.env[ENV_KEY] = value;
    expect(resolveCredentialKey()).toEqual(expected);
  });

  it.each([undefined, "   "])("throws when env var is missing or empty", (value) => {
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    expect(() => resolveCredentialKey()).toThrow(/RD_SYNC_BANK_CREDENTIAL_KEY is not set/);
  });

  it("throws for unsupported key versions", () => {
    process.env[ENV_KEY] = key32.toString("base64");
    expect(() => resolveCredentialKey(2)).toThrow(/Unsupported key version: 2/);
  });

  it.each([
    ["not-a-valid-key-format!!", /not valid base64 or hex/],
    [Buffer.alloc(16, 0x42).toString("base64"), /decoded to 16 bytes/],
  ])("throws safe errors for invalid keys", (value, message) => {
    process.env[ENV_KEY] = value;
    expect(() => resolveCredentialKey()).toThrow(message);
    try {
      resolveCredentialKey();
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
});
