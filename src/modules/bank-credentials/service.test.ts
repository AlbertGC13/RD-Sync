import { describe, expect, it, vi } from "vitest";
import { encryptCredentialField } from "./crypto";
import { BankCredentialService, CREDENTIAL_AUDIT_ACTIONS, CURRENT_CREDENTIAL_WRITE_KEY_VERSION } from "./service";
import { BankCredentialRepository, type BankCredentialRecord } from "./repository";

const TEST_KEY = Buffer.alloc(32, 0x42);
const testKeyResolver = (version = CURRENT_CREDENTIAL_WRITE_KEY_VERSION) => {
  if (version !== CURRENT_CREDENTIAL_WRITE_KEY_VERSION) throw new Error(`Unsupported key version: ${version}`);
  return TEST_KEY;
};
function record(options: { valid?: boolean; keyVersion?: number; isActive?: boolean } = {}): BankCredentialRecord {
  const { valid = true, keyVersion = CURRENT_CREDENTIAL_WRITE_KEY_VERSION, isActive = true } = options;
  const envelope = (value: string) => JSON.stringify(encryptCredentialField(value, () => TEST_KEY, keyVersion));
  return {
    id: "cred-1", bankCode: "popular",
    encryptedUsernameEnvelope: valid ? envelope("user") : "{}",
    encryptedPasswordEnvelope: valid ? envelope("pass") : "{}",
    keyVersion, isActive, lastRotatedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
}
function setup(existing?: BankCredentialRecord | null) {
  const events: Array<{ action: string; metadata: unknown }> = [];
  const repository = {
    findByBankCode: vi.fn().mockResolvedValue(existing ?? null),
    upsert: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ ...record(), ...input })),
    getMetadata: vi.fn().mockResolvedValue({ bankCode: "popular", isActive: true, keyVersion: 1, lastRotatedAt: null }),
  } as unknown as BankCredentialRepository;
  const auditSink = {
    record: vi.fn().mockImplementation(async (event: { action: string; metadata: unknown }) => events.push(event)),
  };
  return { events, repository, svc: new BankCredentialService({ repository, keyResolver: testKeyResolver, auditSink }) };
}
describe("BankCredentialService", () => {
  it("sets new credentials with set audit and no plaintext metadata", async () => {
    const { events, repository, svc } = setup(null);
    const result = await svc.setOrRotate({ bankCode: "popular", username: "u1", password: "p1" }, "admin-1");
    expect(result.action).toBe("set");
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(events[0].action).toBe(CREDENTIAL_AUDIT_ACTIONS.SET);
    expect(JSON.stringify(events[0].metadata)).not.toContain("u1");
  });

  it("rotates existing credentials with rotate audit", async () => {
    const { events, repository, svc } = setup(record({ keyVersion: 99, isActive: false }));
    expect((await svc.setOrRotate({ bankCode: "popular", username: "new", password: "new" }, "a")).action).toBe("rotate");
    expect(repository.upsert).toHaveBeenCalledWith(expect.objectContaining({ keyVersion: CURRENT_CREDENTIAL_WRITE_KEY_VERSION }));
    expect(events[0].action).toBe(CREDENTIAL_AUDIT_ACTIONS.ROTATE);
  });

  it.each([
    { label: "active record decrypts", existing: record(), outcome: "decrypted" },
    { label: "missing record is not configured", existing: null, outcome: "not_configured" },
    { label: "inactive record is not decrypted", existing: record({ isActive: false }), outcome: "inactive" },
    { label: "malformed envelope fails safely", existing: record({ valid: false }), outcome: "decryption_failed" },
    { label: "unsupported stored key is reported", existing: record({ keyVersion: 99 }), outcome: "unsupported_key_version" },
  ] as const)("validateStoredCredentialDecryption returns $outcome for $label", async ({ existing, outcome }) => {
    const { events, svc } = setup(existing);
    await expect(svc.validateStoredCredentialDecryption("popular", "admin-1")).resolves.toMatchObject({ outcome });
    expect(events[0].action).toBe(CREDENTIAL_AUDIT_ACTIONS.TEST);
  });

  it.each([
    ["set", null, (svc: BankCredentialService) => svc.setOrRotate({ bankCode: "x", username: "u", password: "p" }, "a")],
    ["test", record(), (svc: BankCredentialService) => svc.validateStoredCredentialDecryption("x", "a")],
  ] as const)("fails closed if %s audit recording fails", async (_label, existing, act) => {
    const { repository } = setup(existing);
    const svc = new BankCredentialService({ repository, keyResolver: testKeyResolver, auditSink: { record: vi.fn().mockRejectedValue(new Error("down")) } });
    await expect(act(svc)).rejects.toThrow("down");
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("requires an audit sink dependency", () => {
    const { repository } = setup(null);
    expect(() => new BankCredentialService({ repository, keyResolver: testKeyResolver } as never)).toThrow(/audit sink/);
  });

  it("getMetadata delegates to metadata-only repository access", async () => {
    const { svc } = setup(null);
    await expect(svc.getMetadata("popular")).resolves.toMatchObject({ bankCode: "popular" });
  });

  it("BankCredentialRepository keeps metadata reads ciphertext-free and reactivates upserts", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue(null);
    const repository = new BankCredentialRepository({ bankCredential: { findUnique, upsert } } as never);
    await repository.getMetadata("popular");
    await repository.upsert({ bankCode: "popular", encryptedUsernameEnvelope: "u", encryptedPasswordEnvelope: "p", keyVersion: 1 });
    const select = findUnique.mock.calls[0][0].select;
    expect(select).toEqual({ bankCode: true, isActive: true, keyVersion: true, lastRotatedAt: true });
    expect(JSON.stringify(select)).not.toContain("encrypted");
    expect(upsert.mock.calls[0][0].update).toMatchObject({ isActive: true });
  });
});
