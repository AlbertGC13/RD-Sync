import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// resolveDefaultSessionChecker env resolution
//
// We cannot import defaults.ts directly because it reads env at module-load
// time. We test the resolution functions by calling them after setting env vars
// in each test, then importing the module freshly via dynamic import with cache
// busting (resetModules). Each test group calls the isolated factory directly.
// ---------------------------------------------------------------------------

// We test the exported factories by re-importing after env changes.
// Use the factory functions directly rather than the module-level singletons.

describe("resolveDefaultSessionChecker — env branches", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
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

  it("returns a CdpSessionChecker (has check()) when RD_SYNC_SCRAPER=popular-cdp", async () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = "http://localhost:9222";

    const { resolveDefaultSessionChecker } = await import("./defaults");
    const checker = resolveDefaultSessionChecker();

    // We only assert it has the check method — we don't actually connect
    expect(typeof checker.check).toBe("function");
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
