import { describe, expect, it, vi } from "vitest";
import { BankAdapterConfigRepository, type BankAdapterConfigRecord } from "./repository";
import type { PrismaClient } from "../../generated/prisma/client";

function defaultRow(overrides: Partial<BankAdapterConfigRecord> = {}): BankAdapterConfigRecord {
  return {
    bankCode: "popular",
    scrapingEnabled: true,
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    updatedBy: null,
    ...overrides,
  };
}

function makePrisma(overrides: { findUnique?: unknown; update?: unknown } = {}) {
  const bankAdapterConfig = {
    findUnique: vi.fn().mockResolvedValue(overrides.findUnique ?? null),
    update: vi.fn().mockResolvedValue(overrides.update ?? defaultRow()),
  };
  return { prisma: { bankAdapterConfig } as unknown as PrismaClient, bankAdapterConfig };
}

describe("BankAdapterConfigRepository.getByBankCode", () => {
  it("returns null for an unknown bankCode (fail closed, no fallback)", async () => {
    const { prisma } = makePrisma({ findUnique: null });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.getByBankCode("unknown")).resolves.toBeNull();
  });

  it("returns the row for a known bankCode", async () => {
    const { prisma } = makePrisma({ findUnique: defaultRow({ scrapingEnabled: false }) });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.getByBankCode("popular")).resolves.toMatchObject({ bankCode: "popular", scrapingEnabled: false });
  });
});

describe("BankAdapterConfigRepository.setScrapingEnabled", () => {
  it("is a no-op for an unknown bankCode — never falls back to another bank", async () => {
    const { prisma, bankAdapterConfig } = makePrisma({ findUnique: null });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.setScrapingEnabled("unknown", false, "admin-1")).resolves.toBeNull();
    expect(bankAdapterConfig.update).not.toHaveBeenCalled();
  });

  it("disables scraping for one bank without touching auto-login state (separate kill switch)", async () => {
    const { prisma, bankAdapterConfig } = makePrisma({
      findUnique: defaultRow(),
      update: defaultRow({ scrapingEnabled: false, updatedBy: "admin-1" }),
    });
    const repo = new BankAdapterConfigRepository(prisma);
    const record = await repo.setScrapingEnabled("popular", false, "admin-1");
    expect(record).toMatchObject({ scrapingEnabled: false, updatedBy: "admin-1" });
    expect(bankAdapterConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { scrapingEnabled: false, updatedBy: "admin-1" } }),
    );
  });

  it("re-enables scraping (rollback path)", async () => {
    const { prisma } = makePrisma({
      findUnique: defaultRow({ scrapingEnabled: false }),
      update: defaultRow({ scrapingEnabled: true, updatedBy: "admin-2" }),
    });
    const repo = new BankAdapterConfigRepository(prisma);
    const record = await repo.setScrapingEnabled("popular", true, "admin-2");
    expect(record?.scrapingEnabled).toBe(true);
  });
});
