import { decryptCredentialField, type AesGcmEnvelope } from "../../modules/bank-credentials/crypto";

const BANK_CODE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PINNED_KEY_VERSION_MISMATCH = "Pinned credential key version mismatch";
const credentialBrand: unique symbol = Symbol("strict-auto-login-credential");

type StructuralReason = "invalid_request" | "not_configured" | "inactive" | "bank_mismatch" | "invalid_record" | "version_mismatch" | "malformed_envelope" | "blank_plaintext";
type TransientReason = "repository_unavailable" | "key_unavailable" | "decryption_failed" | "audit_unavailable";

export type StrictAutoLoginCredential = Readonly<{ bankCode: string; username: string; password: string; readonly [credentialBrand]: true }>;
export type StrictAutoLoginCredentialLoadResult = Readonly<{ status: "loaded"; credential: StrictAutoLoginCredential }> | Readonly<{ status: "structural_unavailable"; reason: StructuralReason }> | Readonly<{ status: "transient_unavailable"; reason: TransientReason }>;
export interface StrictAutoLoginCredentialLoader {
  load(bankCode: unknown): Promise<StrictAutoLoginCredentialLoadResult>;
}
export interface StrictAutoLoginCredentialLoaderDependencies {
  findAuthenticationMaterialByBankCode(bankCode: string): Promise<unknown>;
  resolveKey(keyVersion: number): unknown;
  decrypt?(envelope: AesGcmEnvelope, key: Buffer): string;
  recordDecryptUse(metadata: { bankCode: string; keyVersion: number }): Promise<void>;
}

const structural = (reason: StructuralReason): StrictAutoLoginCredentialLoadResult => Object.freeze({ status: "structural_unavailable" as const, reason });
const transient = (reason: TransientReason): StrictAutoLoginCredentialLoadResult => Object.freeze({ status: "transient_unavailable" as const, reason });
const nonblank = (value: unknown): value is string => typeof value === "string" && /\S/.test(value);

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parsed: Record<string, unknown> = {};
    for (const key of keys) { const descriptor = descriptors[key]; if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null; parsed[key] = descriptor.value; }
    return parsed;
  } catch { return null; }
}

function parseEnvelope(value: unknown): AesGcmEnvelope | null {
  try {
    const parsed = exact(JSON.parse(typeof value === "string" ? value : ""), ["keyVersion", "iv", "ciphertext", "tag"]);
    return parsed && Number.isSafeInteger(parsed.keyVersion) && (parsed.keyVersion as number) > 0 && nonblank(parsed.iv) && nonblank(parsed.ciphertext) && nonblank(parsed.tag)
      ? { keyVersion: parsed.keyVersion as number, iv: parsed.iv, ciphertext: parsed.ciphertext, tag: parsed.tag }
      : null;
  } catch { return null; }
}

export function createStrictAutoLoginCredentialLoader(dependencies: StrictAutoLoginCredentialLoaderDependencies): StrictAutoLoginCredentialLoader {
  let findAuthenticationMaterialByBankCode: StrictAutoLoginCredentialLoaderDependencies["findAuthenticationMaterialByBankCode"];
  let resolveKey: StrictAutoLoginCredentialLoaderDependencies["resolveKey"];
  let recordDecryptUse: StrictAutoLoginCredentialLoaderDependencies["recordDecryptUse"];
  let decrypt: StrictAutoLoginCredentialLoaderDependencies["decrypt"];
  try {
    ({ findAuthenticationMaterialByBankCode, resolveKey, recordDecryptUse } = dependencies);
    decrypt = dependencies.decrypt;
    if (typeof findAuthenticationMaterialByBankCode !== "function" || typeof resolveKey !== "function" || typeof recordDecryptUse !== "function") throw new Error("invalid dependency");
  } catch {
    return Object.freeze({ async load(bankCode: unknown): Promise<StrictAutoLoginCredentialLoadResult> { return typeof bankCode === "string" && BANK_CODE_RE.test(bankCode) ? transient("repository_unavailable") : structural("invalid_request"); } });
  }
  return Object.freeze({
    async load(bankCode: unknown): Promise<StrictAutoLoginCredentialLoadResult> {
      if (typeof bankCode !== "string" || !BANK_CODE_RE.test(bankCode)) return structural("invalid_request");
      let material: unknown;
      try { material = await findAuthenticationMaterialByBankCode(bankCode); } catch { return transient("repository_unavailable"); }
      if (material == null) return structural("not_configured");
      const record = exact(material, ["bankCode", "isActive", "keyVersion", "encryptedUsernameEnvelope", "encryptedPasswordEnvelope"]);
      if (!record || typeof record.bankCode !== "string" || typeof record.isActive !== "boolean" || !Number.isSafeInteger(record.keyVersion) || (record.keyVersion as number) <= 0 || typeof record.encryptedUsernameEnvelope !== "string" || typeof record.encryptedPasswordEnvelope !== "string") return structural("invalid_record");
      const keyVersion = record.keyVersion as number;
      if (record.bankCode !== bankCode) return structural("bank_mismatch");
      if (!record.isActive) return structural("inactive");
      const usernameEnvelope = parseEnvelope(record.encryptedUsernameEnvelope);
      const passwordEnvelope = parseEnvelope(record.encryptedPasswordEnvelope);
      if (!usernameEnvelope || !passwordEnvelope) return structural("malformed_envelope");
      if (keyVersion !== usernameEnvelope.keyVersion || keyVersion !== passwordEnvelope.keyVersion) return structural("version_mismatch");
      let key: unknown;
      try { key = resolveKey(keyVersion); } catch { return transient("key_unavailable"); }
      if (!Buffer.isBuffer(key) || key.length !== 32) return transient("key_unavailable");
      const decryptField = decrypt ?? ((envelope: AesGcmEnvelope, pinnedKey: Buffer) => decryptCredentialField(envelope, (requestedVersion) => {
        if (requestedVersion !== keyVersion) throw new Error(PINNED_KEY_VERSION_MISMATCH);
        return pinnedKey;
      }));
      let username: string;
      try { username = decryptField(usernameEnvelope, key); } catch { return transient("decryption_failed"); }
      if (!nonblank(username)) return structural("blank_plaintext");
      let password: string;
      try { password = decryptField(passwordEnvelope, key); } catch { return transient("decryption_failed"); }
      if (!nonblank(password)) return structural("blank_plaintext");
      try { await recordDecryptUse(Object.freeze({ bankCode, keyVersion })); } catch { return transient("audit_unavailable"); }
      return Object.freeze({ status: "loaded" as const, credential: Object.freeze({ bankCode, username, password, [credentialBrand]: true as const }) });
    },
  });
}
