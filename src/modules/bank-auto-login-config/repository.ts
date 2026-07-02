/**
 * Prisma repository for `BankAutoLoginConfig` — per-bank auto-login kill
 * switch + circuit-breaker state. Speaks domain `bankCode` (`Bank.code`)
 * everywhere, never Prisma's internal `Bank.id`. Unknown bankCode always
 * fails closed (null / no-op, never falls back to another bank). Unused
 * in production yet — the state machine (PR4.4/4.5) is the first caller.
 */

import type { PrismaClient } from "../../generated/prisma/client";
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

type Row = {
  bankCode: string;
  autoLoginEnabled: boolean;
  breakerState: string;
  breakerFailureCount: number;
  breakerFailureWindowStart: Date | null;
  breakerOpenedAt: Date | null;
  breakerLastResetAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
};

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

/** Validates the persisted breaker state against the closed|open union — rejects any other value. */
function toBreakerState(value: string): BreakerState {
  if (value !== "closed" && value !== "open") {
    throw new Error(`Invalid breaker state persisted for BankAutoLoginConfig: ${value}`);
  }
  return value;
}

function mapRow(row: Row): BankAutoLoginConfigRecord {
  return { ...row, breakerState: toBreakerState(row.breakerState) };
}

export class BankAutoLoginConfigRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Returns `null` for an unknown bankCode — never falls back to another bank. */
  async getByBankCode(bankCode: string): Promise<BankAutoLoginConfigRecord | null> {
    const row = await this.prisma.bankAutoLoginConfig.findUnique({
      where: { bankCode },
      select: RECORD_SELECT,
    });
    return row ? mapRow(row) : null;
  }

  /** Auto-provisions the default row (mirrors `upsertBankByCode`). Fails closed (null) if the parent Bank row is missing. */
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
      if (isForeignKeyViolation(error)) return null;
      throw error;
    }
  }

  /** Applies the pure `nextStateOnFailure` transition for one failure at `now`. Fail-closed no-op for an unknown bankCode. */
  async recordFailure(bankCode: string, now: Date): Promise<BankAutoLoginConfigRecord | null> {
    const existing = await this.prisma.bankAutoLoginConfig.findUnique({
      where: { bankCode },
      select: RECORD_SELECT,
    });
    if (!existing) return null;

    const next = nextStateOnFailure(mapRow(existing), now);
    const row = await this.prisma.bankAutoLoginConfig.update({
      where: { bankCode },
      data: {
        breakerState: next.breakerState,
        breakerFailureCount: next.breakerFailureCount,
        breakerFailureWindowStart: next.breakerFailureWindowStart,
        ...(next.breakerOpenedAt ? { breakerOpenedAt: next.breakerOpenedAt } : {}),
      },
      select: RECORD_SELECT,
    });
    return mapRow(row);
  }

  /** Explicit force-open, independent of failure counting. Idempotent while already open; no-op for unknown bankCode. */
  async openBreaker(bankCode: string, now: Date): Promise<BankAutoLoginConfigRecord | null> {
    const existing = await this.prisma.bankAutoLoginConfig.findUnique({
      where: { bankCode },
      select: RECORD_SELECT,
    });
    if (!existing) return null;
    if (existing.breakerState === "open") return mapRow(existing);

    const row = await this.prisma.bankAutoLoginConfig.update({
      where: { bankCode },
      data: { breakerState: "open", breakerOpenedAt: now },
      select: RECORD_SELECT,
    });
    return mapRow(row);
  }

  /** The ONLY open->closed transition. Clears count/window, stamps `breakerLastResetAt`; requires `updatedBy`. */
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
        breakerLastResetAt: now,
        updatedBy,
      },
      select: RECORD_SELECT,
    });
    return mapRow(row);
  }

  /** Flips the manual auto-login kill switch. Fail-closed no-op for an unknown bankCode. */
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
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2003"
  );
}
