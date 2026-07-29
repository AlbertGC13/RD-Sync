import { describe, expect, it, vi } from "vitest";

import { createSetAutoLoginEnabledAndAudit } from "./defaults";

describe("createSetAutoLoginEnabledAndAudit", () => {
  it("uses one transaction-scoped repository write and audit insert", async () => {
    const setAutoLoginEnabled = vi.fn().mockResolvedValue({ bankCode: "popular", autoLoginEnabled: true });
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = { bankAutoLoginConfig: {}, auditEvent: { create: auditCreate } };
    const prisma = { $transaction: vi.fn(async (work) => work(tx)) };
    const command = createSetAutoLoginEnabledAndAudit({ prisma: prisma as never, repositoryFactory: (receivedTx) => {
      expect(receivedTx).toBe(tx);
      return { setAutoLoginEnabled };
    } });

    await expect(command({ bankCode: "popular", enabled: true, adminId: "admin-1" })).resolves.toEqual({ bankCode: "popular", autoLoginEnabled: true });
    expect(setAutoLoginEnabled).toHaveBeenCalledWith("popular", true, "admin-1");
    expect(setAutoLoginEnabled).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      actorId: "admin-1", actorRole: "admin", action: "bank_killswitch.auto_login_enabled", target: "bank_auto_login_config", targetId: "popular", metadata: { bankCode: "popular" },
    }) }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects the transaction when audit persistence rejects", async () => {
    const setAutoLoginEnabled = vi.fn().mockResolvedValue({ bankCode: "popular", autoLoginEnabled: false });
    const auditCreate = vi.fn().mockRejectedValue(new Error("audit failure"));
    const tx = { bankAutoLoginConfig: {}, auditEvent: { create: auditCreate } };
    const prisma = { $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx) };
    const command = createSetAutoLoginEnabledAndAudit({ prisma: prisma as never, repositoryFactory: () => ({ setAutoLoginEnabled }) });

    await expect(command({ bankCode: "popular", enabled: false, adminId: "admin-1" })).rejects.toThrow("audit failure");
    expect(setAutoLoginEnabled).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it("returns null without inserting an audit event when config is absent", async () => {
    const auditCreate = vi.fn();
    const tx = { bankAutoLoginConfig: {}, auditEvent: { create: auditCreate } };
    const prisma = { $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx) };
    const setAutoLoginEnabled = vi.fn().mockResolvedValue(null);
    const command = createSetAutoLoginEnabledAndAudit({ prisma: prisma as never, repositoryFactory: () => ({ setAutoLoginEnabled }) });

    await expect(command({ bankCode: "popular", enabled: true, adminId: "admin-1" })).resolves.toBeNull();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(setAutoLoginEnabled).toHaveBeenCalledTimes(1);
  });

  it("writes the exact disabled audit action and metadata", async () => {
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = { bankAutoLoginConfig: {}, auditEvent: { create: auditCreate } };
    const prisma = { $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx) };
    const command = createSetAutoLoginEnabledAndAudit({ prisma: prisma as never, repositoryFactory: () => ({ setAutoLoginEnabled: vi.fn().mockResolvedValue({ bankCode: "popular", autoLoginEnabled: false }) }) });

    await command({ bankCode: "popular", enabled: false, adminId: "admin-1" });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "bank_killswitch.auto_login_disabled", metadata: { bankCode: "popular" } }) }));
  });

  it("rejects before audit when the repository write rejects", async () => {
    const auditWriter = vi.fn();
    const tx = { bankAutoLoginConfig: {}, auditEvent: { create: vi.fn() } };
    const prisma = { $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx) };
    const setAutoLoginEnabled = vi.fn().mockRejectedValue(new Error("repository failure"));
    const command = createSetAutoLoginEnabledAndAudit({ prisma: prisma as never, repositoryFactory: () => ({ setAutoLoginEnabled }), auditWriter });

    await expect(command({ bankCode: "popular", enabled: true, adminId: "admin-1" })).rejects.toThrow("repository failure");
    expect(setAutoLoginEnabled).toHaveBeenCalledTimes(1);
    expect(setAutoLoginEnabled).toHaveBeenCalledWith("popular", true, "admin-1");
    expect(auditWriter).not.toHaveBeenCalled();
  });
});
