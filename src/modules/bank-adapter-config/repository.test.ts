import { describe, expect, it, vi } from "vitest";
import { BankAdapterConfigRepository, type BankAdapterConfigRecord } from "./repository";
import type { PrismaClient } from "../../generated/prisma/client";

const RECORD_SELECT = {
  bankCode: true,
  scrapingEnabled: true,
  updatedAt: true,
  updatedBy: true,
} as const;

type FindUniqueArgs = { where: { bankCode: string }; select?: unknown };
type UpdateArgs = { where: { bankCode: string }; data: { scrapingEnabled: boolean; updatedBy: string }; select?: unknown };
type FindUniqueResult = BankAdapterConfigRecord | { bankCode: string } | null;

function defaultRow(overrides: Partial<BankAdapterConfigRecord> = {}): BankAdapterConfigRecord {
  return {
    bankCode: "popular",
    scrapingEnabled: true,
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    updatedBy: null,
    ...overrides,
  };
}

function makePrisma(
  overrides: {
    findUnique?: FindUniqueResult | ((args: FindUniqueArgs) => FindUniqueResult | Promise<FindUniqueResult>);
    update?: BankAdapterConfigRecord | ((args: UpdateArgs) => BankAdapterConfigRecord | Promise<BankAdapterConfigRecord>);
  } = {},
) {
  const bankAdapterConfig = {
    findUnique: vi.fn((args: FindUniqueArgs) => {
      const result = overrides.findUnique ?? null;
      return Promise.resolve(typeof result === "function" ? result(args) : result);
    }),
    update: vi.fn((args: UpdateArgs) => {
      const result = overrides.update ?? defaultRow();
      return Promise.resolve(typeof result === "function" ? result(args) : result);
    }),
  };
  return { prisma: { bankAdapterConfig } as unknown as PrismaClient, bankAdapterConfig };
}

describe("BankAdapterConfigRepository.getByBankCode", () => {
  it("returns null for an unknown bankCode (fail closed, no fallback)", async () => {
    const rowsByBankCode = new Map([["popular", defaultRow()]]);
    const { prisma, bankAdapterConfig } = makePrisma({
      findUnique: ({ where }) => rowsByBankCode.get(where.bankCode) ?? null,
    });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.getByBankCode("unknown")).resolves.toBeNull();
    expect(bankAdapterConfig.findUnique).toHaveBeenCalledWith({ where: { bankCode: "unknown" }, select: RECORD_SELECT });
  });

  it("returns the row for a known bankCode", async () => {
    const { prisma, bankAdapterConfig } = makePrisma({
      findUnique: ({ where }) => (where.bankCode === "popular" ? defaultRow({ scrapingEnabled: false }) : null),
    });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.getByBankCode("popular")).resolves.toMatchObject({ bankCode: "popular", scrapingEnabled: false });
    expect(bankAdapterConfig.findUnique).toHaveBeenCalledWith({ where: { bankCode: "popular" }, select: RECORD_SELECT });
  });
});

describe("BankAdapterConfigRepository.setScrapingEnabled", () => {
  it("is a no-op for an unknown bankCode — never falls back to another bank", async () => {
    const { prisma, bankAdapterConfig } = makePrisma({ findUnique: null });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.setScrapingEnabled("unknown", false, "admin-1")).resolves.toBeNull();
    expect(bankAdapterConfig.findUnique).toHaveBeenCalledWith({ where: { bankCode: "unknown" }, select: { bankCode: true } });
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
    expect(bankAdapterConfig.findUnique).toHaveBeenCalledWith({ where: { bankCode: "popular" }, select: { bankCode: true } });
    expect(bankAdapterConfig.update).toHaveBeenCalledWith({
      where: { bankCode: "popular" },
      data: { scrapingEnabled: false, updatedBy: "admin-1" },
      select: RECORD_SELECT,
    });
  });

  it("re-enables scraping (rollback path)", async () => {
    const { prisma, bankAdapterConfig } = makePrisma({
      findUnique: defaultRow({ scrapingEnabled: false }),
      update: defaultRow({ scrapingEnabled: true, updatedBy: "admin-2" }),
    });
    const repo = new BankAdapterConfigRepository(prisma);
    const record = await repo.setScrapingEnabled("popular", true, "admin-2");
    expect(record?.scrapingEnabled).toBe(true);
    expect(bankAdapterConfig.update).toHaveBeenCalledWith({
      where: { bankCode: "popular" },
      data: { scrapingEnabled: true, updatedBy: "admin-2" },
      select: RECORD_SELECT,
    });
  });
});
