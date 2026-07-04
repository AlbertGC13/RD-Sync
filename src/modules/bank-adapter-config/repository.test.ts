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
type BankFindUniqueArgs = { where: { code: string }; select?: unknown };
type UpsertArgs = {
  where: { bankCode: string };
  update: { scrapingEnabled: boolean; updatedBy: string };
  create: { bankCode: string; scrapingEnabled: boolean; updatedBy: string };
  select?: unknown;
};
type FindUniqueResult = BankAdapterConfigRecord | null;
type BankFindUniqueResult = { code: string } | null;

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
    bankFindUnique?: BankFindUniqueResult | ((args: BankFindUniqueArgs) => BankFindUniqueResult | Promise<BankFindUniqueResult>);
    upsert?: BankAdapterConfigRecord | ((args: UpsertArgs) => BankAdapterConfigRecord | Promise<BankAdapterConfigRecord>);
  } = {},
) {
  const bank = {
    findUnique: vi.fn((args: BankFindUniqueArgs) => {
      const result = overrides.bankFindUnique ?? null;
      return Promise.resolve(typeof result === "function" ? result(args) : result);
    }),
  };
  const bankAdapterConfig = {
    findUnique: vi.fn((args: FindUniqueArgs) => {
      const result = overrides.findUnique ?? null;
      return Promise.resolve(typeof result === "function" ? result(args) : result);
    }),
    upsert: vi.fn((args: UpsertArgs) => {
      const result = overrides.upsert ?? defaultRow();
      return Promise.resolve(typeof result === "function" ? result(args) : result);
    }),
  };
  return { prisma: { bank, bankAdapterConfig } as unknown as PrismaClient, bank, bankAdapterConfig };
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
    const { prisma, bank, bankAdapterConfig } = makePrisma({ bankFindUnique: null });
    const repo = new BankAdapterConfigRepository(prisma);
    await expect(repo.setScrapingEnabled("unknown", false, "admin-1")).resolves.toBeNull();
    expect(bank.findUnique).toHaveBeenCalledWith({ where: { code: "unknown" }, select: { code: true } });
    expect(bankAdapterConfig.findUnique).not.toHaveBeenCalled();
    expect(bankAdapterConfig.upsert).not.toHaveBeenCalled();
  });

  it("creates config for a known bank missing a config row", async () => {
    const { prisma, bank, bankAdapterConfig } = makePrisma({
      bankFindUnique: { code: "popular" },
      upsert: defaultRow({ scrapingEnabled: false, updatedBy: "admin-1" }),
    });
    const repo = new BankAdapterConfigRepository(prisma);
    const record = await repo.setScrapingEnabled("popular", false, "admin-1");
    expect(record).toMatchObject({ scrapingEnabled: false, updatedBy: "admin-1" });
    expect(bank.findUnique).toHaveBeenCalledWith({ where: { code: "popular" }, select: { code: true } });
    expect(bankAdapterConfig.findUnique).not.toHaveBeenCalled();
    expect(bankAdapterConfig.upsert).toHaveBeenCalledWith({
      where: { bankCode: "popular" },
      update: { scrapingEnabled: false, updatedBy: "admin-1" },
      create: { bankCode: "popular", scrapingEnabled: false, updatedBy: "admin-1" },
      select: RECORD_SELECT,
    });
  });

  it("re-enables scraping (rollback path)", async () => {
    const { prisma, bank, bankAdapterConfig } = makePrisma({
      bankFindUnique: { code: "popular" },
      upsert: defaultRow({ scrapingEnabled: true, updatedBy: "admin-2" }),
    });
    const repo = new BankAdapterConfigRepository(prisma);
    const record = await repo.setScrapingEnabled("popular", true, "admin-2");
    expect(record?.scrapingEnabled).toBe(true);
    expect(bank.findUnique).toHaveBeenCalledWith({ where: { code: "popular" }, select: { code: true } });
    expect(bankAdapterConfig.upsert).toHaveBeenCalledWith({
      where: { bankCode: "popular" },
      update: { scrapingEnabled: true, updatedBy: "admin-2" },
      create: { bankCode: "popular", scrapingEnabled: true, updatedBy: "admin-2" },
      select: RECORD_SELECT,
    });
  });
});
