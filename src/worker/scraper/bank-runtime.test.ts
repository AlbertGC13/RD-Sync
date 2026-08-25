import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createExactBankRuntimeResolver, createPopularBankRuntimeResolver } from "./bank-runtime";

describe("bank runtime resolver", () => {
  it("dispatches Popular only by its exact canonical code", async () => {
    const ensureBrowserSession = vi.fn(async () => ({ status: "ready" as const }));
    const ensureBrowser = vi.fn(async () => ({ status: "throttled" as const }));
    const sessionChecker = { check: vi.fn(async () => ({ status: "active", checkedAt: "2026-08-24T00:00:00.000Z", safeSummary: "safe" })) };
    const resolver = createExactBankRuntimeResolver([{
      bankCode: "popular",
      cdpUrl: "http://127.0.0.1:9222",
      ensureBrowserSession,
      ensureBrowser,
      sessionChecker,
    }]);

    expect(resolver.cdpUrlForBankCode("popular")).toBe("http://127.0.0.1:9222");
    expect(resolver.resolveSessionChecker("popular")).toBe(sessionChecker);
    await expect(resolver.ensureBrowserSession("popular")).resolves.toEqual({ status: "ready" });
    await expect(resolver.ensureBrowser("popular", "http://127.0.0.1:9222")).resolves.toEqual({ status: "throttled" });
    expect(ensureBrowserSession).toHaveBeenCalledWith("popular");
    expect(ensureBrowser).toHaveBeenCalledWith("popular", "http://127.0.0.1:9222");

    for (const bankCode of ["Popular", "bhd", "banreservas", "unknown"]) {
      expect(resolver.cdpUrlForBankCode(bankCode)).toBeUndefined();
      expect(resolver.resolveSessionChecker(bankCode)).toBeUndefined();
      await expect(resolver.ensureBrowserSession(bankCode)).resolves.toEqual({ status: "unavailable" });
      await expect(resolver.ensureBrowser(bankCode, "http://127.0.0.1:9222")).rejects.toThrow("Bank browser runtime is unavailable");
    }
    expect(ensureBrowserSession).toHaveBeenCalledOnce();
    expect(ensureBrowser).toHaveBeenCalledOnce();
    expect(sessionChecker.check).not.toHaveBeenCalled();
  });

  it("rejects a mismatched endpoint before invoking the exact bank opener", async () => {
    const ensureBrowser = vi.fn(async () => ({ status: "throttled" as const }));
    const resolver = createExactBankRuntimeResolver([{
      bankCode: "popular",
      cdpUrl: "http://127.0.0.1:9222",
      ensureBrowserSession: async () => ({ status: "ready" as const }),
      ensureBrowser,
      sessionChecker: { check: async () => ({}) },
    }]);

    await expect(resolver.ensureBrowser("popular", "http://127.0.0.1:9333")).rejects.toThrow("Bank browser runtime is unavailable");
    expect(ensureBrowser).not.toHaveBeenCalled();
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

  it("binds Popular trusted login configuration once in its runtime", async () => {
    const opener = vi.fn(async () => ({ status: "throttled" as const }));
    const createBrowserOpener = vi.fn(() => opener);
    const resolver = createPopularBankRuntimeResolver({
      RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
      RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS: "4321",
    }, { createBrowserOpener });

    expect(createBrowserOpener).toHaveBeenCalledWith(expect.objectContaining({
      trustedLoginUrl: "https://ib.bpd.com.do",
      visibleSelectorTimeoutMs: 4321,
    }));
    expect(resolver.cdpUrlForBankCode("popular")).toBe("http://127.0.0.1:9333");
    await expect(resolver.ensureBrowser("popular", "http://127.0.0.1:9333")).resolves.toEqual({ status: "throttled" });
    expect(opener).toHaveBeenCalledWith("popular", "http://127.0.0.1:9333");
  });

  it("keeps Popular opener construction out of the worker composition root", async () => {
    const source = await readFile(new URL("../ingestion-worker.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/popularPortalConfig|createScrapeTimeAutoLoginBrowserOpener|createEnsureBrowserForBank|createAcquireBrowserSlotFromEnv/);
  });
});
