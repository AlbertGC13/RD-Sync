/**
 * Default service singleton for bank credential admin routes.
 *
 * Uses the shared PrismaClient singleton from persistence/prisma-client.ts.
 * The key resolver reads RD_SYNC_BANK_CREDENTIAL_KEY at call time.
 * Audit sink uses the shared default from api/audit/defaults.
 *
 * Lazy initialization: the service is created on first access, not at module
 * import time. This prevents PrismaClient instantiation during test setup
 * when DATABASE_URL is not set.
 */

import { getPrismaClient } from "../../../modules/persistence/prisma-client";
import { BankCredentialRepository } from "../../../modules/bank-credentials/repository";
import { BankCredentialService } from "../../../modules/bank-credentials/service";
import { resolveCredentialKey } from "../../../modules/bank-credentials/key-resolver";
import { defaultAuditSink } from "../audit/defaults";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncBankCredentialService?: BankCredentialService;
};

function createBankCredentialService(): BankCredentialService {
  const prisma = getPrismaClient();
  const repository = new BankCredentialRepository(prisma);
  return new BankCredentialService({
    repository,
    keyResolver: resolveCredentialKey,
    auditSink: defaultAuditSink,
  });
}

/**
 * Lazy singleton — created on first access, not at module import time.
 * This prevents PrismaClient instantiation during test setup.
 */
export function getDefaultBankCredentialService(): BankCredentialService {
  return (globalRegistry.__rdSyncBankCredentialService ??= createBankCredentialService());
}
