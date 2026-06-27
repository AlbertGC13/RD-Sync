import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// resolveDefaultSessionChecker env resolution
//
// We cannot import defaults.ts directly because it reads env at module-load
// time. We test the resolution functions by calling them after setting env vars
// in each test, then importing the module freshly via dynamic import with cache
// busting (resetModules). Each test group calls the isolated factory directly.
// ---------------------------------------------------------------------------

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

    // Import the factory fresh (but it reads env at call time — we call inline)
    const { resolveDefaultSessionChecker } = await import("./defaults");
    const checker = resolveDefaultSessionChecker();
    const result = await checker.check();

    expect(result.status).toBe("browser_unavailable");
    expect(result.safeSummary).toBe("Bank browser session is not available");
  });

  // Real behavior test (not just a seam): the per-bank Popular CDP URL must win
  // over the global one, and that exact URL must reach createCdpSessionChecker.
  it("constructs the CDP checker with the per-bank URL when both per-bank and global are set", async () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_BANK_POPULAR_CDP_URL = "http://127.0.0.1:9333";
    process.env.RD_SYNC_CDP_URL = "http://127.0.0.1:9222";

    const createSpy = vi.fn(() => ({ check: vi.fn() }));
    vi.doMock(BANK_SESSIONS_MODULE, async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../../../modules/bank-sessions")
      >()),
      createCdpSessionChecker: createSpy,
    }));
    vi.resetModules();

    const { resolveDefaultSessionChecker } = await import("./defaults");
    createSpy.mockClear(); // drop the module-load-time construction, if any
    resolveDefaultSessionChecker();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({ cdpUrl: "http://127.0.0.1:9333" });
  });

  it("falls back to the global CDP URL when only the global is set", async () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = "http://127.0.0.1:9222";

    const createSpy = vi.fn(() => ({ check: vi.fn() }));
    vi.doMock(BANK_SESSIONS_MODULE, async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../../../modules/bank-sessions")
      >()),
      createCdpSessionChecker: createSpy,
    }));
    vi.resetModules();

    const { resolveDefaultSessionChecker } = await import("./defaults");
    createSpy.mockClear();
    resolveDefaultSessionChecker();

    expect(createSpy).toHaveBeenCalledWith({ cdpUrl: "http://127.0.0.1:9222" });
  });
});

describe("resolveDefaultSessionMonitor — env branches", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_SESSION_MONITOR;
    delete process.env.RD_SYNC_SESSION_CHECK_INTERVAL_MS;
  });

  it("returns null when RD_SYNC_SESSION_MONITOR is not set", async () => {
    delete process.env.RD_SYNC_SESSION_MONITOR;

    const { resolveDefaultSessionMonitor } = await import("./defaults");
    const monitor = resolveDefaultSessionMonitor();

    expect(monitor).toBeNull();
  });

  it("returns null when RD_SYNC_SESSION_MONITOR=disabled", async () => {
    process.env.RD_SYNC_SESSION_MONITOR = "disabled";

    const { resolveDefaultSessionMonitor } = await import("./defaults");
    const monitor = resolveDefaultSessionMonitor();

    expect(monitor).toBeNull();
  });

  it("returns a monitor with start/stop/tick/lastResult when RD_SYNC_SESSION_MONITOR=enabled", async () => {
    process.env.RD_SYNC_SESSION_MONITOR = "enabled";

    const { resolveDefaultSessionMonitor } = await import("./defaults");
    const monitor = resolveDefaultSessionMonitor();

    expect(monitor).not.toBeNull();
    expect(typeof monitor?.start).toBe("function");
    expect(typeof monitor?.stop).toBe("function");
    expect(typeof monitor?.tick).toBe("function");
    expect(typeof monitor?.lastResult).toBe("function");
  });
});

describe("startDefaultSessionMonitorIfEnabled — does not throw", () => {
  beforeEach(() => {
    delete process.env.RD_SYNC_SESSION_MONITOR;
  });

  afterEach(() => {
    delete process.env.RD_SYNC_SESSION_MONITOR;
  });

  it("does not throw when monitor is disabled", async () => {
    const { startDefaultSessionMonitorIfEnabled } = await import("./defaults");
    expect(() => startDefaultSessionMonitorIfEnabled()).not.toThrow();
  });
});
