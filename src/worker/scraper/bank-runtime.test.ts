import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createBhdPersonalBankRuntime, createExactBankRuntimeResolver, createPopularBankRuntimeResolver } from "./bank-runtime";

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

  it("creates an exact inert BHD Personal runtime from its isolated endpoint", async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    const checker = { check: vi.fn(async () => ({ status: "active", checkedAt: "2026-08-24T00:00:00.000Z", safeSummary: "safe" })) };
    const createSessionChecker = vi.fn(() => checker);
    const opener = vi.fn(async () => ({ status: "throttled" as const }));
    const createBrowserOpener = vi.fn(() => opener);
    const runtime = createBhdPersonalBankRuntime({
      RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9444",
    }, { browserRuntime: { fetch }, createSessionChecker, createBrowserOpener });

    expect(runtime?.bankCode).toBe("bhd_personal");
    expect(runtime?.cdpUrl).toBe("http://127.0.0.1:9444");
    expect(createSessionChecker).toHaveBeenCalledWith("http://127.0.0.1:9444");
    expect(createBrowserOpener).toHaveBeenCalledWith(expect.objectContaining({
      trustedLoginUrl: "https://ibp.bhd.com.do/#/login",
    }));
    await expect(runtime?.ensureBrowserSession("bhd_personal")).resolves.toEqual({ status: "ready" });
    await expect(runtime?.ensureBrowserSession("bhd")).resolves.toEqual({ status: "unavailable" });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9444/json/version", expect.anything());

    const resolver = createExactBankRuntimeResolver(runtime ? [runtime] : []);
    expect(resolver.cdpUrlForBankCode("bhd_personal")).toBe("http://127.0.0.1:9444");
    expect(resolver.resolveSessionChecker("bhd_personal")).toBe(checker);
    await expect(resolver.ensureBrowser("bhd_personal", "http://127.0.0.1:9444")).resolves.toEqual({ status: "throttled" });
    await expect(resolver.ensureBrowser("bhd", "http://127.0.0.1:9444")).rejects.toThrow("Bank browser runtime is unavailable");
  });

  it("supports a manually-running BHD browser and binds auto-launch to its portal identity", async () => {
    const manualFetch = vi.fn(async () => ({ ok: true }));
    const manualRuntime = createBhdPersonalBankRuntime({
      RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9444",
    }, { browserRuntime: { fetch: manualFetch }, createSessionChecker: () => ({ check: async () => ({}) }) });
    await expect(manualRuntime?.ensureBrowserSession("bhd_personal")).resolves.toEqual({ status: "ready" });

    const fetch = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    const spawn = vi.fn();
    const runtime = createBhdPersonalBankRuntime({
      RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9444",
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND: "launch-bhd-personal",
      RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS: "1000",
      RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS: "1",
    }, { browserRuntime: { fetch, spawn, sleep: async () => {}, now: (() => { let now = 0; return () => now++; })() }, createSessionChecker: () => ({ check: async () => ({}) }) });
    await expect(runtime?.ensureBrowserSession("bhd_personal")).resolves.toEqual({ status: "ready" });
    expect(spawn).toHaveBeenCalledWith("launch-bhd-personal", { env: { BANK_CODE: "bhd_personal" } });
  });

  it("never uses global, brand, or other-portal BHD endpoints as fallback sources", () => {
    const checkerFactory = () => ({ check: async () => ({}) });
    for (const env of [
      { RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "", RD_SYNC_CDP_URL: "http://127.0.0.1:9222" },
      { RD_SYNC_CDP_URL: "http://127.0.0.1:9222" },
      { RD_SYNC_BANK_BHD_CDP_URL: "http://127.0.0.1:9222" },
      { RD_SYNC_BANK_BHD_EMPRESARIAL_CDP_URL: "http://127.0.0.1:9222" },
      { RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://10.0.0.1:9222", RD_SYNC_CDP_URL: "http://127.0.0.1:9222" },
    ]) expect(createBhdPersonalBankRuntime(env, { createSessionChecker: checkerFactory })).toBeUndefined();
  });

  it("uses a valid BHD Personal endpoint despite unrelated endpoint configuration", () => {
    const createSessionChecker = vi.fn(() => ({ check: async () => ({}) }));
    const runtime = createBhdPersonalBankRuntime({
      RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9444",
      RD_SYNC_CDP_URL: "http://127.0.0.1:9222",
      RD_SYNC_BANK_BHD_CDP_URL: "http://127.0.0.1:9333",
      RD_SYNC_BANK_BHD_EMPRESARIAL_CDP_URL: "http://127.0.0.1:9555",
    }, { createSessionChecker });

    expect(runtime?.cdpUrl).toBe("http://127.0.0.1:9444");
    expect(createSessionChecker).toHaveBeenCalledWith("http://127.0.0.1:9444");
  });

  it("requires an injected BHD read-only session checker and leaves BHD out of the worker runtime", async () => {
    expect(createBhdPersonalBankRuntime({ RD_SYNC_BANK_BHD_PERSONAL_CDP_URL: "http://127.0.0.1:9444" })).toBeUndefined();
    const source = await readFile(new URL("../ingestion-worker.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createBhdPersonalBankRuntime|bhd_personal/);
  });
});
