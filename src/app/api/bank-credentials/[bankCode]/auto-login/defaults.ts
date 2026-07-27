import type { Prisma, PrismaClient } from "../../../../../generated/prisma/client";
import { createAuditEvent, type AuditEvent } from "../../../../../modules/audit";
import { BANK_KILLSWITCH_ACTIONS } from "../../../../../modules/audit/bank-actions";
import { BankAutoLoginConfigRepository } from "../../../../../modules/bank-auto-login-config/repository";
import { getPrismaClient } from "../../../../../modules/persistence/prisma-client";

export interface SetAutoLoginEnabledAndAuditInput {
  bankCode: string;
  enabled: boolean;
  adminId: string;
}

/** Atomic request-attempt command; state PATCH is idempotent but audit rows are not retried or deduplicated here. */
export type SetAutoLoginEnabledAndAudit = (input: SetAutoLoginEnabledAndAuditInput) => Promise<{ bankCode: string; autoLoginEnabled: boolean } | null>;

type TransactionClient = Prisma.TransactionClient;
type Repository = Pick<BankAutoLoginConfigRepository, "setAutoLoginEnabled">;
type AuditWriter = (tx: TransactionClient, event: AuditEvent) => Promise<void>;

export function createSetAutoLoginEnabledAndAudit(options: {
  prisma?: Pick<PrismaClient, "$transaction">;
  repositoryFactory?: (tx: TransactionClient) => Repository;
  auditWriter?: AuditWriter;
} = {}): SetAutoLoginEnabledAndAudit {
  const prisma = options.prisma ?? getPrismaClient();
  const repositoryFactory = options.repositoryFactory ?? ((tx) => new BankAutoLoginConfigRepository(tx as unknown as PrismaClient));
  const auditWriter = options.auditWriter ?? writeAudit;

  return async ({ bankCode, enabled, adminId }) => prisma.$transaction(async (tx) => {
    const config = await repositoryFactory(tx).setAutoLoginEnabled(bankCode, enabled, adminId);
    if (!config) return null;
    const event = createAuditEvent({
      actorId: adminId,
      actorRole: "admin",
      action: enabled ? BANK_KILLSWITCH_ACTIONS.AUTO_LOGIN_ENABLED : BANK_KILLSWITCH_ACTIONS.AUTO_LOGIN_DISABLED,
      target: "bank_auto_login_config",
      targetId: bankCode,
      metadata: { bankCode },
    });
    await auditWriter(tx, event);
    return { bankCode: config.bankCode, autoLoginEnabled: config.autoLoginEnabled };
  });
}

async function writeAudit(tx: TransactionClient, event: AuditEvent): Promise<void> {
  await tx.auditEvent.create({ data: { ...event, metadata: event.metadata as Prisma.InputJsonValue } });
}

export const defaultSetAutoLoginEnabledAndAudit: SetAutoLoginEnabledAndAudit = async (input) =>
  createSetAutoLoginEnabledAndAudit()(input);
