import { describe, expect, it, vi } from "vitest";
import { BankAutoLoginConfigRepository } from "./repository";
import type { PrismaClient } from "../../generated/prisma/client";

/** Mirrors the raw Prisma row shape (breakerState is a plain `string` column). */
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

function defaultRow(overrides: Partial<RawRow> = {}): RawRow {
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
    upsert: vi.fn().mockResolvedValue(overrides.upsert ?? defaultRow()),
    update: vi.fn().mockResolvedValue(overrides.update ?? defaultRow()),
  };
  return { prisma: { bankAutoLoginConfig } as unknown as PrismaClient, bankAutoLoginConfig };
}

describe("BankAutoLoginConfigRepository.getByBankCode", () => {
  it("returns null for an unknown bankCode (fail closed, no fallback)", async () => {
    const { prisma } = makePrisma({ findUnique: null });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.getByBankCode("unknown")).resolves.toBeNull();
  });

  it("maps a known row", async () => {
    const { prisma } = makePrisma({ findUnique: defaultRow({ autoLoginEnabled: true }) });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.getByBankCode("popular");
    expect(record).toMatchObject({ bankCode: "popular", autoLoginEnabled: true, breakerState: "closed" });
  });

  it("rejects a persisted breaker state outside the closed|open union", async () => {
    const { prisma } = makePrisma({ findUnique: defaultRow({ breakerState: "half_open" }) });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.getByBankCode("popular")).rejects.toThrow(/Invalid breaker state/);
  });
});

describe("BankAutoLoginConfigRepository.upsertDefaults", () => {
  it("auto-provisions the default row for a known bank", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma();
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.upsertDefaults("popular");
    expect(record).toMatchObject({ bankCode: "popular", autoLoginEnabled: false, breakerState: "closed" });
    expect(bankAutoLoginConfig.upsert).toHaveBeenCalledOnce();
  });

  it("fails closed (returns null, no auto-provisioned Bank row) when the parent Bank does not exist", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma();
    bankAutoLoginConfig.upsert.mockRejectedValue({ code: "P2003" });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.upsertDefaults("unknown")).resolves.toBeNull();
  });
});

describe("BankAutoLoginConfigRepository.recordFailure", () => {
  it("is a no-op for an unknown bankCode", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma({ findUnique: null });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.recordFailure("unknown", new Date())).resolves.toBeNull();
    expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
  });

  it("increments the failure count and persists the window on the first failure", async () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const { prisma, bankAutoLoginConfig } = makePrisma({
      findUnique: defaultRow(),
      update: defaultRow({ breakerFailureCount: 1, breakerFailureWindowStart: now }),
    });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.recordFailure("popular", now);
    expect(record).toMatchObject({ breakerFailureCount: 1, breakerState: "closed" });
    const updateArgs = bankAutoLoginConfig.update.mock.calls[0][0];
    expect(updateArgs.data.breakerOpenedAt).toBeUndefined(); // untouched — did not just open
  });

  it("opens the breaker on the 3rd failure inside the window and stamps breakerOpenedAt", async () => {
    const t0 = new Date("2026-07-02T12:00:00.000Z");
    const t2 = new Date("2026-07-02T12:10:00.000Z");
    const { prisma, bankAutoLoginConfig } = makePrisma({
      findUnique: defaultRow({ breakerFailureCount: 2, breakerFailureWindowStart: t0 }),
      update: defaultRow({ breakerState: "open", breakerFailureCount: 3, breakerFailureWindowStart: t0, breakerOpenedAt: t2 }),
    });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.recordFailure("popular", t2);
    expect(record?.breakerState).toBe("open");
    const updateArgs = bankAutoLoginConfig.update.mock.calls[0][0];
    expect(updateArgs.data.breakerOpenedAt).toEqual(t2);
  });
});

describe("BankAutoLoginConfigRepository.openBreaker", () => {
  it("is a no-op for an unknown bankCode", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma({ findUnique: null });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.openBreaker("unknown", new Date())).resolves.toBeNull();
    expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
  });

  it("is idempotent when already open — does not re-write", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma({ findUnique: defaultRow({ breakerState: "open" }) });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.openBreaker("popular", new Date());
    expect(record?.breakerState).toBe("open");
    expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
  });

  it("force-opens a closed breaker", async () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    const { prisma, bankAutoLoginConfig } = makePrisma({
      findUnique: defaultRow(),
      update: defaultRow({ breakerState: "open", breakerOpenedAt: now }),
    });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.openBreaker("popular", now);
    expect(record?.breakerState).toBe("open");
    expect(bankAutoLoginConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { breakerState: "open", breakerOpenedAt: now } }),
    );
  });
});

describe("BankAutoLoginConfigRepository.resetBreaker", () => {
  it("requires a non-empty updatedBy actor id", async () => {
    const { prisma } = makePrisma();
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.resetBreaker("popular", "")).rejects.toThrow(/updatedBy/);
  });

  it("is a no-op for an unknown bankCode", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma({ findUnique: null });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.resetBreaker("unknown", "admin-1")).resolves.toBeNull();
    expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
  });

  it("clears state, count, and window and stamps breakerLastResetAt + updatedBy — the ONLY open->closed path", async () => {
    const now = new Date("2026-07-02T13:00:00.000Z");
    const { prisma, bankAutoLoginConfig } = makePrisma({
      findUnique: defaultRow({ bankCode: "popular" }),
      update: defaultRow({ breakerState: "closed", breakerLastResetAt: now, updatedBy: "admin-1" }),
    });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.resetBreaker("popular", "admin-1", now);
    expect(record).toMatchObject({ breakerState: "closed", updatedBy: "admin-1" });
    expect(bankAutoLoginConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          breakerState: "closed",
          breakerFailureCount: 0,
          breakerFailureWindowStart: null,
          breakerLastResetAt: now,
          updatedBy: "admin-1",
        },
      }),
    );
  });
});

describe("BankAutoLoginConfigRepository.setAutoLoginEnabled", () => {
  it("is a no-op for an unknown bankCode", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma({ findUnique: null });
    const repo = new BankAutoLoginConfigRepository(prisma);
    await expect(repo.setAutoLoginEnabled("unknown", true, "admin-1")).resolves.toBeNull();
    expect(bankAutoLoginConfig.update).not.toHaveBeenCalled();
  });

  it("flips the flag and stamps updatedBy", async () => {
    const { prisma, bankAutoLoginConfig } = makePrisma({
      findUnique: defaultRow(),
      update: defaultRow({ autoLoginEnabled: true, updatedBy: "admin-1" }),
    });
    const repo = new BankAutoLoginConfigRepository(prisma);
    const record = await repo.setAutoLoginEnabled("popular", true, "admin-1");
    expect(record).toMatchObject({ autoLoginEnabled: true, updatedBy: "admin-1" });
    expect(bankAutoLoginConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { autoLoginEnabled: true, updatedBy: "admin-1" } }),
    );
  });
});
