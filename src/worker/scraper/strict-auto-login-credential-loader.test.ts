import { describe, expect, it, vi } from "vitest";

import { encryptCredentialField } from "../../modules/bank-credentials/crypto";
import { createStrictAutoLoginCredentialLoader, isStrictAutoLoginCredential } from "./strict-auto-login-credential-loader";

const envelope = (keyVersion = 1) => JSON.stringify({ keyVersion, iv: "iv", ciphertext: "cipher", tag: "tag" });
const record = (overrides: Record<string, unknown> = {}) => ({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: envelope(), encryptedPasswordEnvelope: envelope(), ...overrides });

function fixture(overrides: Partial<Parameters<typeof createStrictAutoLoginCredentialLoader>[0]> = {}) {
  const calls: string[] = [];
  const findAuthenticationMaterialByBankCode = vi.fn(async () => { calls.push("repo"); return record(); });
  const resolveKey = vi.fn(() => { calls.push("key"); return Buffer.alloc(32); });
  const decrypt = vi.fn((value: { ciphertext: string }) => { calls.push(value.ciphertext === "cipher" ? `decrypt:${calls.filter((call) => call.startsWith("decrypt")).length}` : "bad"); return calls.filter((call) => call.startsWith("decrypt")).length === 1 ? "user" : "pass"; });
  const recordDecryptUse = vi.fn(async () => { calls.push("audit"); });
  return { calls, findAuthenticationMaterialByBankCode, resolveKey, decrypt, recordDecryptUse, loader: createStrictAutoLoginCredentialLoader({ findAuthenticationMaterialByBankCode, resolveKey, decrypt, recordDecryptUse, ...overrides }) };
}

describe("createStrictAutoLoginCredentialLoader", () => {
  it("rejects invalid requests before accessing dependencies", async () => {
    for (const input of [undefined, "", "Popular", "a".repeat(33), "bad!", {}, new Proxy({}, { get() { throw new Error("secret"); } })]) {
      const f = fixture();
      await expect(f.loader.load(input)).resolves.toEqual({ status: "structural_unavailable", reason: "invalid_request" });
      expect(f.findAuthenticationMaterialByBankCode).not.toHaveBeenCalled();
      expect(f.resolveKey).not.toHaveBeenCalled();
    }
  });

  it("classifies repository failures and unavailable material without leaking values", async () => {
    for (const material of [null, undefined]) {
      const f = fixture({ findAuthenticationMaterialByBankCode: vi.fn(async () => material) });
      await expect(f.loader.load("popular")).resolves.toEqual({ status: "structural_unavailable", reason: "not_configured" });
    }
    const f = fixture({ findAuthenticationMaterialByBankCode: vi.fn(async () => { throw { secret: "secret" }; }) });
    const result = await f.loader.load("popular");
    expect(result).toEqual({ status: "transient_unavailable", reason: "repository_unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/secret|error|key|cipher|plain/i);
  });

  it("rejects malformed materials, inactive records, and bank mismatches before key access", async () => {
    const hidden = record(); Object.defineProperty(hidden, "hidden", { value: true });
    const symbol = Object.assign(record(), { [Symbol("secret")]: true });
    const malformed = [[], Object.create(record()), Object.defineProperty(record(), "isActive", { get() { return true; } }), hidden, symbol, Object.assign(record(), { extra: true }), Object.assign(record(), { bankCode: 1 }), Object.assign(record(), { isActive: 1 }), Object.assign(record(), { keyVersion: NaN }), Object.assign(record(), { keyVersion: Infinity }), Object.assign(record(), { keyVersion: 0 }), Object.assign(record(), { keyVersion: -1 }), Object.assign(record(), { keyVersion: 1.5 }), Object.assign(record(), { encryptedUsernameEnvelope: 1 })];
    for (const material of malformed) {
      const f = fixture({ findAuthenticationMaterialByBankCode: vi.fn(async () => material) });
      await expect(f.loader.load("popular")).resolves.toEqual({ status: "structural_unavailable", reason: "invalid_record" });
      expect(f.resolveKey).not.toHaveBeenCalled();
    }
    for (const material of [record({ isActive: false }), record({ bankCode: "other" })]) {
      const f = fixture({ findAuthenticationMaterialByBankCode: vi.fn(async () => material) });
      await expect(f.loader.load("popular")).resolves.toEqual(material.isActive === false ? { status: "structural_unavailable", reason: "inactive" } : { status: "structural_unavailable", reason: "bank_mismatch" });
      expect(f.resolveKey).not.toHaveBeenCalled();
    }
  });

  it("parses both strict envelopes before resolving a key and rejects structural envelope faults", async () => {
    const badValues = ["{", "null", "[]", JSON.stringify({}), JSON.stringify({ keyVersion: 1, iv: "", ciphertext: "c", tag: "t" }), JSON.stringify({ keyVersion: 1, iv: 1, ciphertext: "c", tag: "t" }), JSON.stringify({ keyVersion: 1, iv: "i", ciphertext: "c", tag: "t", extra: true }), JSON.stringify({ keyVersion: 0, iv: "i", ciphertext: "c", tag: "t" })];
    for (const value of badValues) {
      const f = fixture({ findAuthenticationMaterialByBankCode: vi.fn(async () => record({ encryptedUsernameEnvelope: value, encryptedPasswordEnvelope: value })) });
      await expect(f.loader.load("popular")).resolves.toEqual({ status: "structural_unavailable", reason: "malformed_envelope" });
      expect(f.resolveKey).not.toHaveBeenCalled();
    }
    for (const versions of [[2, 1], [1, 2], [2, 3]]) {
      const f = fixture({ findAuthenticationMaterialByBankCode: vi.fn(async () => record({ encryptedUsernameEnvelope: envelope(versions[0]), encryptedPasswordEnvelope: envelope(versions[1]) })) });
      await expect(f.loader.load("popular")).resolves.toEqual({ status: "structural_unavailable", reason: "version_mismatch" });
      expect(f.resolveKey).not.toHaveBeenCalled();
    }
  });

  it("fails closed for unavailable keys and decrypt or audit failures", async () => {
    for (const resolveKey of [() => { throw new Error("key"); }, () => Buffer.alloc(31), () => ({})]) {
      const f = fixture({ resolveKey });
      await expect(f.loader.load("popular")).resolves.toEqual({ status: "transient_unavailable", reason: "key_unavailable" });
      expect(f.decrypt).not.toHaveBeenCalled();
    }
    const userFailure = fixture({ decrypt: vi.fn(() => { throw new Error("secret"); }) });
    await expect(userFailure.loader.load("popular")).resolves.toEqual({ status: "transient_unavailable", reason: "decryption_failed" });
    expect(userFailure.recordDecryptUse).not.toHaveBeenCalled();
    const blankDecrypt = vi.fn(() => " ");
    const blankUsername = fixture({ decrypt: blankDecrypt });
    await expect(blankUsername.loader.load("popular")).resolves.toEqual({ status: "structural_unavailable", reason: "blank_plaintext" });
    expect(blankDecrypt).toHaveBeenCalledTimes(1);
    expect(blankUsername.recordDecryptUse).not.toHaveBeenCalled();
    const passwordFailure = fixture({ decrypt: vi.fn().mockReturnValueOnce("user").mockReturnValueOnce(" ") });
    await expect(passwordFailure.loader.load("popular")).resolves.toEqual({ status: "structural_unavailable", reason: "blank_plaintext" });
    expect(passwordFailure.recordDecryptUse).not.toHaveBeenCalled();
    const auditFailure = fixture({ recordDecryptUse: vi.fn(async () => { throw new Error("secret"); }) });
    await expect(auditFailure.loader.load("popular")).resolves.toEqual({ status: "transient_unavailable", reason: "audit_unavailable" });
  });

  it("uses the default AES decrypt seam with one pinned key resolution and frozen audit metadata", async () => {
    const keyVersion = 7;
    const key = Buffer.alloc(32, 7);
    const keyResolver = vi.fn((version: number) => { expect(version).toBe(keyVersion); return key; });
    const usernameEnvelope = encryptCredentialField("default-user", keyResolver, keyVersion);
    const passwordEnvelope = encryptCredentialField("default-password", keyResolver, keyVersion);
    keyResolver.mockClear();
    const audit = vi.fn(async (metadata: { bankCode: string; keyVersion: number }) => {
      expect([Object.isFrozen(metadata), Reflect.ownKeys(metadata), metadata]).toEqual([true, ["bankCode", "keyVersion"], { bankCode: "popular", keyVersion }]);
    });
    const loader = createStrictAutoLoginCredentialLoader({
      findAuthenticationMaterialByBankCode: async () => record({ keyVersion, encryptedUsernameEnvelope: JSON.stringify(usernameEnvelope), encryptedPasswordEnvelope: JSON.stringify(passwordEnvelope) }),
      resolveKey: keyResolver,
      recordDecryptUse: audit,
    });

    const result = await loader.load("popular");
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") expect([result.credential.bankCode, result.credential.username, result.credential.password]).toEqual(["popular", "default-user", "default-password"]);
    expect(keyResolver).toHaveBeenCalledOnce();
    expect(keyResolver).toHaveBeenCalledWith(keyVersion);
    expect(audit).toHaveBeenCalledOnce();
  });

  it("does not audit when the second decrypt throws", async () => {
    const decrypt = vi.fn().mockReturnValueOnce("user").mockImplementationOnce(() => { throw new Error("secret"); });
    const audit = vi.fn(async () => undefined);
    const loader = createStrictAutoLoginCredentialLoader({
      findAuthenticationMaterialByBankCode: async () => record(),
      resolveKey: () => Buffer.alloc(32),
      decrypt,
      recordDecryptUse: audit,
    });

    await expect(loader.load("popular")).resolves.toEqual({ status: "transient_unavailable", reason: "decryption_failed" });
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(audit).not.toHaveBeenCalled();
  });

  it("loads only after the exact ordered, pinned, audited flow", async () => {
    const f = fixture();
    const result = await f.loader.load("popular");
    expect(f.calls).toEqual(["repo", "key", "decrypt:0", "decrypt:1", "audit"]);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect([Object.isFrozen(result), Object.isFrozen(result.credential), result.credential.bankCode, result.credential.username, result.credential.password]).toEqual([true, true, "popular", "user", "pass"]);
    }
    expect(f.resolveKey).toHaveBeenCalledTimes(1);
    expect(f.resolveKey).toHaveBeenCalledWith(1);
    expect(f.recordDecryptUse).toHaveBeenCalledWith({ bankCode: "popular", keyVersion: 1 });
  });

  it("fails closed when dependency access throws during construction", async () => {
    const loader = createStrictAutoLoginCredentialLoader(new Proxy({}, { get() { throw new Error("secret"); } }) as Parameters<typeof createStrictAutoLoginCredentialLoader>[0]);
    await expect(loader.load("popular")).resolves.toEqual({ status: "transient_unavailable", reason: "repository_unavailable" });
  });
  it("recognizes only credentials minted after the complete load flow", async () => {
    const loaded = await fixture().loader.load("popular");
    if (loaded.status !== "loaded") throw new Error("fixture");
    const forged = Object.freeze({ bankCode: loaded.credential.bankCode, username: loaded.credential.username, password: loaded.credential.password, [Symbol("strict-auto-login-credential")]: true });
    expect([isStrictAutoLoginCredential(loaded.credential), isStrictAutoLoginCredential(forged), isStrictAutoLoginCredential(new Proxy(forged, {})), isStrictAutoLoginCredential(null)]).toEqual([true, false, false, false]);
  });
});
