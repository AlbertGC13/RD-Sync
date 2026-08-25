import { describe, expect, it, vi } from "vitest";

import { createExactBankRuntimeResolver, createPopularBankRuntimeResolver } from "./bank-runtime";

describe("bank runtime resolver", () => {
  it("dispatches Popular only by its exact canonical code", async () => {
    const ensureBrowserSession = vi.fn(async () => ({ status: "ready" as const }));
    const sessionChecker = { check: vi.fn(async () => ({ status: "active", checkedAt: "2026-08-24T00:00:00.000Z", safeSummary: "safe" })) };
    const resolver = createExactBankRuntimeResolver([{
      bankCode: "popular",
      cdpUrl: "http://127.0.0.1:9222",
      ensureBrowserSession,
      sessionChecker,
    }]);

    expect(resolver.cdpUrlForBankCode("popular")).toBe("http://127.0.0.1:9222");
    expect(resolver.resolveSessionChecker("popular")).toBe(sessionChecker);
    await expect(resolver.ensureBrowserSession("popular")).resolves.toEqual({ status: "ready" });
    expect(ensureBrowserSession).toHaveBeenCalledWith("popular");

    for (const bankCode of ["Popular", "bhd", "banreservas", "unknown"]) {
      expect(resolver.cdpUrlForBankCode(bankCode)).toBeUndefined();
      expect(resolver.resolveSessionChecker(bankCode)).toBeUndefined();
      await expect(resolver.ensureBrowserSession(bankCode)).resolves.toEqual({ status: "unavailable" });
    }
    expect(ensureBrowserSession).toHaveBeenCalledOnce();
    expect(sessionChecker.check).not.toHaveBeenCalled();
  });

  it("shares the explicit Popular endpoint between the runtime ports", async () => {
    const createSessionChecker = vi.fn(() => ({ check: async () => ({}) }));
    const fetch = vi.fn(async () => ({ ok: true }));
    const resolver = createPopularBankRuntimeResolver({
      RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
    }, { browserRuntime: { fetch }, createSessionChecker });

    expect(resolver.cdpUrlForBankCode("popular")).toBe("http://127.0.0.1:9333");
    expect(createSessionChecker).toHaveBeenCalledWith("http://127.0.0.1:9333");
    await expect(resolver.ensureBrowserSession("popular")).resolves.toEqual({ status: "ready" });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9333/json/version", expect.anything());
  });

  it("fails closed when Popular has no valid explicit endpoint and never uses a global fallback", () => {
    for (const env of [
      { RD_SYNC_CDP_URL: "http://127.0.0.1:9222" },
      { RD_SYNC_BANK_POPULAR_CDP_URL: "http://10.0.0.1:9222" },
    ]) {
      const resolver = createPopularBankRuntimeResolver(env);
      expect(resolver.cdpUrlForBankCode("popular")).toBeUndefined();
      expect(resolver.resolveSessionChecker("popular")).toBeUndefined();
    }
  });
});
