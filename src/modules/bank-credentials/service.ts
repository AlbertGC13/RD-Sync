import { decryptCredentialField, encryptCredentialField, type AesGcmEnvelope, type KeyResolver } from "./crypto";
import { BankCredentialRepository, type BankCredentialMetadata } from "./repository";
import { createAuditEvent, type AuditSink } from "../audit";
import { BANK_CREDENTIAL_ACTIONS } from "../audit/bank-actions";

export { BANK_CREDENTIAL_ACTIONS as CREDENTIAL_AUDIT_ACTIONS } from "../audit/bank-actions";

export const CURRENT_CREDENTIAL_WRITE_KEY_VERSION = 1;
export const NO_STORED_CREDENTIAL_KEY_VERSION = 0;

export interface CredentialSetInput {
  bankCode: string;
  username: string;
  password: string;
}

export interface CredentialTestResult {
  bankCode: string;
  outcome: "decrypted" | "not_configured" | "inactive" | "unsupported_key_version" | "key_unavailable" | "decryption_failed";
}

export interface CredentialServiceDeps {
  repository: BankCredentialRepository;
  keyResolver: KeyResolver;
  auditSink: Pick<AuditSink, "record">;
}

export class BankCredentialService {
  constructor(private readonly deps: CredentialServiceDeps) {
    if (!deps.auditSink) throw new Error("Credential audit sink is required");
  }

  async setOrRotate(input: CredentialSetInput, actorId: string): Promise<{ bankCode: string; keyVersion: number; action: "set" | "rotate" }> {
    const existing = await this.deps.repository.findByBankCode(input.bankCode);
    const keyVersion = CURRENT_CREDENTIAL_WRITE_KEY_VERSION;
    const action = existing ? "rotate" : "set";

    const usernameEnvelope = encryptCredentialField(input.username, this.deps.keyResolver, keyVersion);
    const passwordEnvelope = encryptCredentialField(input.password, this.deps.keyResolver, keyVersion);
    await this.emitAudit({
      action: existing ? BANK_CREDENTIAL_ACTIONS.ROTATE : BANK_CREDENTIAL_ACTIONS.SET,
      bankCode: input.bankCode,
      keyVersion,
      actorId,
    });

    await this.deps.repository.upsert({
      bankCode: input.bankCode,
      encryptedUsernameEnvelope: JSON.stringify(usernameEnvelope),
      encryptedPasswordEnvelope: JSON.stringify(passwordEnvelope),
      keyVersion,
    });

    return { bankCode: input.bankCode, keyVersion, action };
  }

  async validateStoredCredentialDecryption(bankCode: string, actorId: string): Promise<CredentialTestResult> {
    const record = await this.deps.repository.findByBankCode(bankCode);

    if (!record) {
      await this.emitTestAudit(bankCode, NO_STORED_CREDENTIAL_KEY_VERSION, actorId, "not_configured");
      return { bankCode, outcome: "not_configured" };
    }

    if (!record.isActive) {
      await this.emitTestAudit(bankCode, record.keyVersion, actorId, "inactive");
      return { bankCode, outcome: "inactive" };
    }

    try {
      decryptCredentialField(parseEnvelope(record.encryptedUsernameEnvelope), this.deps.keyResolver);
      decryptCredentialField(parseEnvelope(record.encryptedPasswordEnvelope), this.deps.keyResolver);

      await this.emitTestAudit(bankCode, record.keyVersion, actorId, "decrypted");

      return { bankCode, outcome: "decrypted" };
    } catch (error) {
      const outcome = classifyDecryptFailure(error);
      await this.emitTestAudit(bankCode, record.keyVersion, actorId, outcome);
      return { bankCode, outcome };
    }
  }

  async getMetadata(bankCode: string): Promise<BankCredentialMetadata | null> {
    return this.deps.repository.getMetadata(bankCode);
  }

  private async emitTestAudit(bankCode: string, keyVersion: number, actorId: string, outcome: CredentialTestResult["outcome"]): Promise<void> {
    await this.emitAudit({ action: BANK_CREDENTIAL_ACTIONS.TEST, bankCode, keyVersion, actorId, outcome });
  }

  private async emitAudit(input: { action: string; bankCode: string; keyVersion: number; actorId: string; outcome?: CredentialTestResult["outcome"] }): Promise<void> {
    await this.deps.auditSink.record(
      createAuditEvent({
        actorId: input.actorId,
        actorRole: "admin",
        action: input.action,
        target: "bank_credential",
        targetId: null,
        metadata: input.outcome === undefined ? { bankCode: input.bankCode, keyVersion: input.keyVersion } : { bankCode: input.bankCode, keyVersion: input.keyVersion, outcome: input.outcome },
      }),
    );
  }
}

function classifyDecryptFailure(error: unknown): CredentialTestResult["outcome"] {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Unsupported key version")) return "unsupported_key_version";
  if (message.includes("RD_SYNC_BANK_CREDENTIAL_KEY") || message.includes("Invalid AES key length")) {
    return "key_unavailable";
  }
  return "decryption_failed";
}

function parseEnvelope(json: string): AesGcmEnvelope {
  const parsed = JSON.parse(json) as Partial<AesGcmEnvelope> | null;
  if (!parsed || typeof parsed.keyVersion !== "number" || typeof parsed.iv !== "string" || typeof parsed.ciphertext !== "string" || typeof parsed.tag !== "string") {
    throw new Error("Malformed credential envelope");
  }
  return parsed as AesGcmEnvelope;
}
