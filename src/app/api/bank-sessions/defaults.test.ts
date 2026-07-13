import { afterEach, describe, expect, it, vi } from "vitest";

const BANK_SESSIONS_MODULE = "../../../modules/bank-sessions";

describe("resolveDefaultSessionChecker — env branches", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_BANK_POPULAR_CDP_URL;
    vi.doUnmock(BANK_SESSIONS_MODULE);
    vi.resetModules();
  });

  it("returns browser_unavailable stub when RD_SYNC_SCRAPER is not set", async () => {
    delete process.env.RD_SYNC_SCRAPER;
    const { resolveDefaultSessionChecker } = await import("./defaults");

    await expect(resolveDefaultSessionChecker().check()).resolves.toMatchObject({
      status: "browser_unavailable",
      safeSummary: "Bank browser session is not available",
    });
  });

  it("constructs the CDP checker with the per-bank URL when both per-bank and global are set", async () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_BANK_POPULAR_CDP_URL = "http://127.0.0.1:9333";
    process.env.RD_SYNC_CDP_URL = "http://127.0.0.1:9222";
    const createSpy = vi.fn(() => ({ check: vi.fn() }));
    vi.doMock(BANK_SESSIONS_MODULE, async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../../modules/bank-sessions")>()),
      createCdpSessionChecker: createSpy,
    }));
    vi.resetModules();

    const { resolveDefaultSessionChecker } = await import("./defaults");
    createSpy.mockClear();
    resolveDefaultSessionChecker();

    expect(createSpy).toHaveBeenCalledWith({ cdpUrl: "http://127.0.0.1:9333" });
  });

  it("falls back to the global CDP URL when only the global is set", async () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = "http://127.0.0.1:9222";
    const createSpy = vi.fn(() => ({ check: vi.fn() }));
    vi.doMock(BANK_SESSIONS_MODULE, async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../../modules/bank-sessions")>()),
      createCdpSessionChecker: createSpy,
    }));
    vi.resetModules();

    const { resolveDefaultSessionChecker } = await import("./defaults");
    createSpy.mockClear();
    resolveDefaultSessionChecker();

    expect(createSpy).toHaveBeenCalledWith({ cdpUrl: "http://127.0.0.1:9222" });
  });
});

describe("resolveDefaultSessionMonitor — dormant production seam", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_SESSION_MONITOR;
    delete process.env.RD_SYNC_SESSION_CHECK_INTERVAL_MS;
  });

  it("remains dormant even when the legacy monitor flag is enabled", async () => {
    process.env.RD_SYNC_SESSION_MONITOR = "enabled";
    const { resolveDefaultSessionMonitor } = await import("./defaults");

    expect(resolveDefaultSessionMonitor()).toBeNull();
  });
});
