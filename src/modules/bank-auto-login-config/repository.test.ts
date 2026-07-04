import { describe, expect, it, vi } from "vitest";
import { BankAutoLoginConfigRepository } from "./repository";
import type { PrismaClient } from "../../generated/prisma/client";

interface RawRow {
  bankCode: string;
  autoLoginEnabled: boolean;
  breakerState: string;
  breakerFailureCount: number;
  breakerFailureWindowStart: Date | null;
  breakerOpenedAt: Date | null;
  breakerLastResetAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
}

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
const BANK_CODE_SELECT = { bankCode: true } as const;
const SERIALIZABLE_OPTIONS = { isolationLevel: "Serializable" };
const NOW = new Date("2026-07-02T12:00:00.000Z");

function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    bankCode: "popular",
    autoLoginEnabled: false,
    breakerState: "closed",
    breakerFailureCount: 0,
    breakerFailureWindowStart: null,
    breakerOpenedAt: null,
    breakerLastResetAt: null,
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    updatedBy: null,
    ...overrides,
  };
}

function makePrisma(overrides: { findUnique?: unknown; upsert?: unknown; update?: unknown } = {}) {
  const bankAutoLoginConfig = {
    findUnique: vi.fn().mockResolvedValue(overrides.findUnique ?? null),
    upsert: vi.fn().mockResolvedValue(overrides.upsert ?? row()),
    update: vi.fn().mockResolvedValue(overrides.update ?? row()),
  };
  const prisma = {
    bankAutoLoginConfig,
    $transaction: vi.fn(async (operation: (tx: { bankAutoLoginConfig: typeof bankAutoLoginConfig }) => unknown) =>
      operation({ bankAutoLoginConfig }),
    ),
  };
  return { prisma: prisma as unknown as PrismaClient, bankAutoLoginConfig, transaction: prisma.$transaction };
}

function expectFindUnique(mock: ReturnType<typeof vi.fn>, bankCode: string, select: unknown = RECORD_SELECT) {
  expect(mock).toHaveBeenCalledWith({ where: { bankCode }, select });
}

function expectUpdate(mock: ReturnType<typeof vi.fn>, bankCode: string, data: unknown) {
  expect(mock).toHaveBeenCalledWith({ where: { bankCode }, data, select: RECORD_SELECT });
}

describe("BankAutoLoginConfigRepository", () => {
  describe("getByBankCode", () => {
    it("returns null for an unknown bankCode with exact isolation", async () => {
      const { repo, bankAutoLoginConfig } = makeRepo({ findUnique: null });
      await expect(repo.getByBankCode("unknown")).resolves.toBeNull();
      expectFindUnique(bankAutoLoginConfig.findUnique, "unknown");
    });

    it("maps known rows and rejects invalid persisted breaker states", async () => {
      await expect(makeRepo({ findUnique: row({ autoLoginEnabled: true }) }).repo.getByBankCode("popular")).resolves.toMatchObject({
        bankCode: "popular",
        autoLoginEnabled: true,
        breakerState: "closed",
      });
      await expect(makeRepo({ findUnique: row({ breakerState: "half_open" }) }).repo.getByBankCode("popular")).rejects.toThrow(
        /Invalid breaker state/,
      );
    });
  });

  describe("upsertDefaults", () => {
    it("auto-provisions only the requested bankCode", async () => {
      const bankCode = "banreservas";
      const { repo, bankAutoLoginConfig } = makeRepo({ upsert: row({ bankCode }) });

      await expect(repo.upsertDefaults(bankCode)).resolves.toMatchObject({ bankCode, autoLoginEnabled: false, breakerState: "closed" });
      expect(bankAutoLoginConfig.upsert).toHaveBeenCalledWith({ where: { bankCode }, update: {}, create: { bankCode }, select: RECORD_SELECT });
    });

    it("fails closed when the parent Bank does not exist", async () => {
      const { repo, bankAutoLoginConfig } = makeRepo();
      bankAutoLoginConfig.upsert.mockRejectedValue({ code: "P2003" });

      await expect(repo.upsertDefaults("unknown")).resolves.toBeNull();
      expect(bankAutoLoginConfig.upsert).toHaveBeenCalledWith({
        where: { bankCode: "unknown" },
        update: {},
        create: { bankCode: "unknown" },
        select: RECORD_SELECT,
      });
    });
  });

  describe("recordFailure", () => {
    it("is a serializable no-op for an unknown bankCode", async () => {
      const { repo, bankAutoLoginConfig, transaction } = makeRepo({ findUnique: null });

      await expect(repo.recordFailure("unknown", NOW)).resolves.toBeNull();

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), SERIALIZABLE_OPTIONS);
      expectFindUnique(bankAutoLoginConfig.findUnique, "unknown");
      expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
    });

    it("persists the full closed-state transition on the first failure", async () => {
      const bankCode = "bhd";
      const { repo, bankAutoLoginConfig, transaction } = makeRepo({
        findUnique: row({ bankCode }),
        update: row({ bankCode, breakerFailureCount: 1, breakerFailureWindowStart: NOW }),
      });

      await expect(repo.recordFailure(bankCode, NOW)).resolves.toMatchObject({ bankCode, breakerFailureCount: 1, breakerState: "closed" });

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), SERIALIZABLE_OPTIONS);
      expectUpdate(bankAutoLoginConfig.update, bankCode, failureData("closed", 1, NOW, null));
    });

    it("opens the breaker on the 3rd failure inside the window", async () => {
      const t0 = new Date("2026-07-02T12:00:00.000Z");
      const openedAt = new Date("2026-07-02T12:10:00.000Z");
      const { repo, bankAutoLoginConfig } = makeRepo({
        findUnique: row({ breakerFailureCount: 2, breakerFailureWindowStart: t0 }),
        update: row({ breakerState: "open", breakerFailureCount: 3, breakerFailureWindowStart: t0, breakerOpenedAt: openedAt }),
      });

      await expect(repo.recordFailure("popular", openedAt)).resolves.toMatchObject({ breakerState: "open", breakerFailureCount: 3 });
      expectUpdate(bankAutoLoginConfig.update, "popular", failureData("open", 3, t0, openedAt));
    });

    it("does not update an already-open breaker", async () => {
      const openedAt = new Date("2026-07-02T11:00:00.000Z");
      const { repo, bankAutoLoginConfig } = makeRepo({ findUnique: row({ breakerState: "open", breakerFailureCount: 3, breakerOpenedAt: openedAt }) });

      await expect(repo.recordFailure("popular", NOW)).resolves.toMatchObject({ breakerState: "open", breakerFailureCount: 3, breakerOpenedAt: openedAt });
      expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
    });

    it("retries serializable write conflicts and recomputes from the latest row", async () => {
      const t0 = new Date("2026-07-02T12:00:00.000Z");
      const openedAt = new Date("2026-07-02T12:10:00.000Z");
      const { repo, bankAutoLoginConfig, transaction } = makeRepo();
      bankAutoLoginConfig.findUnique
        .mockResolvedValueOnce(row({ breakerFailureCount: 1, breakerFailureWindowStart: t0 }))
        .mockResolvedValueOnce(row({ breakerFailureCount: 2, breakerFailureWindowStart: t0 }));
      bankAutoLoginConfig.update
        .mockResolvedValueOnce(row({ breakerFailureCount: 2, breakerFailureWindowStart: t0 }))
        .mockResolvedValueOnce(row({ breakerState: "open", breakerFailureCount: 3, breakerFailureWindowStart: t0, breakerOpenedAt: openedAt }));
      transaction
        .mockImplementationOnce(async (operation: (tx: { bankAutoLoginConfig: typeof bankAutoLoginConfig }) => unknown) => {
          await operation({ bankAutoLoginConfig });
          throw { code: "P2034" };
        })
        .mockImplementationOnce(async (operation: (tx: { bankAutoLoginConfig: typeof bankAutoLoginConfig }) => unknown) => operation({ bankAutoLoginConfig }));

      await expect(repo.recordFailure("popular", openedAt)).resolves.toMatchObject({ breakerState: "open", breakerFailureCount: 3, breakerOpenedAt: openedAt });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), SERIALIZABLE_OPTIONS);
      expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), SERIALIZABLE_OPTIONS);
      expect(bankAutoLoginConfig.update).toHaveBeenNthCalledWith(2, { where: { bankCode: "popular" }, data: failureData("open", 3, t0, openedAt), select: RECORD_SELECT });
    });
  });

  describe("openBreaker", () => {
    it("is a no-op for unknown or already-open rows", async () => {
      const unknown = makeRepo({ findUnique: null });
      await expect(unknown.repo.openBreaker("unknown", NOW)).resolves.toBeNull();
      expectFindUnique(unknown.bankAutoLoginConfig.findUnique, "unknown");
      expect(unknown.bankAutoLoginConfig.update).not.toHaveBeenCalled();

      const opened = makeRepo({ findUnique: row({ breakerState: "open" }) });
      await expect(opened.repo.openBreaker("popular", NOW)).resolves.toMatchObject({ breakerState: "open" });
      expect(opened.bankAutoLoginConfig.update).not.toHaveBeenCalled();
    });

    it("force-opens a closed breaker", async () => {
      const { repo, bankAutoLoginConfig } = makeRepo({ findUnique: row(), update: row({ breakerState: "open", breakerOpenedAt: NOW }) });
      await expect(repo.openBreaker("popular", NOW)).resolves.toMatchObject({ breakerState: "open" });
      expectUpdate(bankAutoLoginConfig.update, "popular", { breakerState: "open", breakerOpenedAt: NOW });
    });
  });

  describe("resetBreaker", () => {
    it("requires updatedBy and is a no-op for unknown bankCode", async () => {
      await expect(makeRepo().repo.resetBreaker("popular", "")).rejects.toThrow(/updatedBy/);

      const { repo, bankAutoLoginConfig } = makeRepo({ findUnique: null });
      await expect(repo.resetBreaker("unknown", "admin-1")).resolves.toBeNull();
      expectFindUnique(bankAutoLoginConfig.findUnique, "unknown", BANK_CODE_SELECT);
      expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
    });

    it("clears breakerOpenedAt and persists reset metadata", async () => {
      const resetAt = new Date("2026-07-02T13:00:00.000Z");
      const data = { breakerState: "closed", breakerFailureCount: 0, breakerFailureWindowStart: null, breakerOpenedAt: null, breakerLastResetAt: resetAt, updatedBy: "admin-1" };
      const { repo, bankAutoLoginConfig } = makeRepo({ findUnique: row(), update: row({ ...data }) });

      await expect(repo.resetBreaker("popular", "admin-1", resetAt)).resolves.toMatchObject({ breakerState: "closed", breakerOpenedAt: null, updatedBy: "admin-1" });
      expectUpdate(bankAutoLoginConfig.update, "popular", data);
    });
  });

  describe("setAutoLoginEnabled", () => {
    it("is a no-op for unknown bankCode and updates only known rows", async () => {
      const unknown = makeRepo({ findUnique: null });
      await expect(unknown.repo.setAutoLoginEnabled("unknown", true, "admin-1")).resolves.toBeNull();
      expectFindUnique(unknown.bankAutoLoginConfig.findUnique, "unknown", BANK_CODE_SELECT);
      expect(unknown.bankAutoLoginConfig.update).not.toHaveBeenCalled();

      const known = makeRepo({ findUnique: row(), update: row({ autoLoginEnabled: true, updatedBy: "admin-1" }) });
      await expect(known.repo.setAutoLoginEnabled("popular", true, "admin-1")).resolves.toMatchObject({ autoLoginEnabled: true, updatedBy: "admin-1" });
      expectUpdate(known.bankAutoLoginConfig.update, "popular", { autoLoginEnabled: true, updatedBy: "admin-1" });
    });
  });
});

function makeRepo(overrides?: Parameters<typeof makePrisma>[0]) {
  const ctx = makePrisma(overrides);
  return { ...ctx, repo: new BankAutoLoginConfigRepository(ctx.prisma) };
}

function failureData(breakerState: "closed" | "open", breakerFailureCount: number, breakerFailureWindowStart: Date, breakerOpenedAt: Date | null) {
  return { breakerState, breakerFailureCount, breakerFailureWindowStart, breakerOpenedAt };
}
