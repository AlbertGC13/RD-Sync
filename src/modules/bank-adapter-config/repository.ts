/**
 * Prisma repository for `BankAdapterConfig` — the per-bank read-only adapter
 * kill switch. Separate from `BankAutoLoginConfig.autoLoginEnabled`:
 * disabling this stops ALL scraping (read-only included) for one bank
 * without touching auto-login state or any other bank.
 *
 * Repos speak domain `bankCode` (`Bank.code`) everywhere, never Prisma's
 * internal `Bank.id`. An unknown `bankCode` always fails closed: methods
 * return `null` instead of ever falling back to another bank's row.
 *
 * Nothing in production wiring calls this repository yet — PR4.3 is
 * plumbing only.
 */

import type { PrismaClient } from "../../generated/prisma/client";

export interface BankAdapterConfigRecord {
  bankCode: string;
  scrapingEnabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

const RECORD_SELECT = {
  bankCode: true,
  scrapingEnabled: true,
  updatedAt: true,
  updatedBy: true,
} as const;

export class BankAdapterConfigRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Returns `null` for an unknown bankCode — never falls back to another bank. */
  async getByBankCode(bankCode: string): Promise<BankAdapterConfigRecord | null> {
    const row = await this.prisma.bankAdapterConfig.findUnique({
      where: { bankCode },
      select: RECORD_SELECT,
    });
    return row ?? null;
  }

  /** Flips the adapter (read-only scraping) kill switch. Fail-closed no-op for an unknown bankCode. */
  async setScrapingEnabled(bankCode: string, enabled: boolean, updatedBy: string): Promise<BankAdapterConfigRecord | null> {
    const existing = await this.prisma.bankAdapterConfig.findUnique({ where: { bankCode }, select: { bankCode: true } });
    if (!existing) return null;

    const row = await this.prisma.bankAdapterConfig.update({
      where: { bankCode },
      data: { scrapingEnabled: enabled, updatedBy },
      select: RECORD_SELECT,
    });
    return row;
  }
}
