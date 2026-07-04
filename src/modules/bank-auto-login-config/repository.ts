import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { nextStateOnFailure, type BreakerState } from "./breaker-policy";

export interface BankAutoLoginConfigRecord {
  bankCode: string;
  autoLoginEnabled: boolean;
  breakerState: BreakerState;
  breakerFailureCount: number;
  breakerFailureWindowStart: Date | null;
  breakerOpenedAt: Date | null;
  breakerLastResetAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
}

type Row = Omit<BankAutoLoginConfigRecord, "breakerState"> & { breakerState: string };
type BankAutoLoginConfigTx = Pick<PrismaClient, "bankAutoLoginConfig">;

const RECORD_SELECT = {
  bankCode: true,
  autoLoginEnabled: true,
  breakerState: true,
  breakerFailureCount: true,
  breakerFailureWindowStart: true,
  breakerOpenedAt: true,
  breakerLastResetAt: true,
  updatedAt: true,
  updatedBy: true,
} as const;

const SERIALIZABLE_RETRY_ATTEMPTS = 3;

function toBreakerState(value: string): BreakerState {
  if (value !== "closed" && value !== "open") {
    throw new Error(`Invalid breaker state persisted for BankAutoLoginConfig: ${value}`);
  }
  return value;
}

function mapRow(row: Row): BankAutoLoginConfigRecord {
  return { ...row, breakerState: toBreakerState(row.breakerState) };
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}

export class BankAutoLoginConfigRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getByBankCode(bankCode: string): Promise<BankAutoLoginConfigRecord | null> {
    const row = await this.prisma.bankAutoLoginConfig.findUnique({ where: { bankCode }, select: RECORD_SELECT });
    return row ? mapRow(row) : null;
  }

  async upsertDefaults(bankCode: string): Promise<BankAutoLoginConfigRecord | null> {
    try {
      const row = await this.prisma.bankAutoLoginConfig.upsert({
        where: { bankCode },
        update: {},
        create: { bankCode },
        select: RECORD_SELECT,
      });
      return mapRow(row);
    } catch (error: unknown) {
      if (hasPrismaCode(error, "P2003")) return null;
      throw error;
    }
  }

  async recordFailure(bankCode: string, now: Date): Promise<BankAutoLoginConfigRecord | null> {
    return this.runSerializableWithRetry(async (tx) => {
      const existing = await tx.bankAutoLoginConfig.findUnique({ where: { bankCode }, select: RECORD_SELECT });
      if (!existing) return null;

      const current = mapRow(existing);
      if (current.breakerState === "open") return current;

      const next = nextStateOnFailure(current, now);
      const row = await tx.bankAutoLoginConfig.update({
        where: { bankCode },
        data: {
          breakerState: next.breakerState,
          breakerFailureCount: next.breakerFailureCount,
          breakerFailureWindowStart: next.breakerFailureWindowStart,
          breakerOpenedAt: next.breakerOpenedAt,
        },
        select: RECORD_SELECT,
      });
      return mapRow(row);
    });
  }

  async openBreaker(bankCode: string, now: Date): Promise<BankAutoLoginConfigRecord | null> {
    const existing = await this.prisma.bankAutoLoginConfig.findUnique({ where: { bankCode }, select: RECORD_SELECT });
    if (!existing) return null;
    if (existing.breakerState === "open") return mapRow(existing);

    const row = await this.prisma.bankAutoLoginConfig.update({
      where: { bankCode },
      data: { breakerState: "open", breakerOpenedAt: now },
      select: RECORD_SELECT,
    });
    return mapRow(row);
  }

  async resetBreaker(bankCode: string, updatedBy: string, now: Date = new Date()): Promise<BankAutoLoginConfigRecord | null> {
    if (!updatedBy) throw new Error("resetBreaker requires an updatedBy actor id");

    const existing = await this.prisma.bankAutoLoginConfig.findUnique({ where: { bankCode }, select: { bankCode: true } });
    if (!existing) return null;

    const row = await this.prisma.bankAutoLoginConfig.update({
      where: { bankCode },
      data: {
        breakerState: "closed",
        breakerFailureCount: 0,
        breakerFailureWindowStart: null,
        breakerOpenedAt: null,
        breakerLastResetAt: now,
        updatedBy,
      },
      select: RECORD_SELECT,
    });
    return mapRow(row);
  }

  async setAutoLoginEnabled(bankCode: string, enabled: boolean, updatedBy: string): Promise<BankAutoLoginConfigRecord | null> {
    const existing = await this.prisma.bankAutoLoginConfig.findUnique({ where: { bankCode }, select: { bankCode: true } });
    if (!existing) return null;

    const row = await this.prisma.bankAutoLoginConfig.update({
      where: { bankCode },
      data: { autoLoginEnabled: enabled, updatedBy },
      select: RECORD_SELECT,
    });
    return mapRow(row);
  }

  private async runSerializableWithRetry<T>(operation: (tx: BankAutoLoginConfigTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error: unknown) {
        if (!hasPrismaCode(error, "P2034") || attempt === SERIALIZABLE_RETRY_ATTEMPTS) throw error;
      }
    }
    throw new Error("Unreachable serializable transaction retry state");
  }
}
