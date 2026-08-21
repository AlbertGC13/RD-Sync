import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// resolveDefaultBrowserCapacityMonitor — env-gated wiring
//
// consumer-defaults.ts also caches a module-load-time singleton on
// globalThis, but that anchor persists across vi.resetModules() within the
// same worker (resetModules only clears the module registry, not
// globalThis) — so this test exercises the resolver function directly,
// mirroring resolveDefaultSessionMonitor's own test in
// src/app/api/bank-sessions/defaults.test.ts. Kept minimal per the line budget.
// ---------------------------------------------------------------------------

describe("resolveDefaultBrowserCapacityMonitor — env branches", () => {
  afterEach(() => {
    delete process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR;
    delete process.env.RD_SYNC_REDIS_URL;
    vi.resetModules();
  });

  it("returns null when RD_SYNC_BROWSER_CAPACITY_MONITOR is not set to 'enabled'", async () => {
    delete process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR;
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";

    const { resolveDefaultBrowserCapacityMonitor } = await import("./consumer-defaults");

    expect(resolveDefaultBrowserCapacityMonitor()).toBeNull();
  });

  it("returns a monitor with start/stop/tick/lastState when RD_SYNC_BROWSER_CAPACITY_MONITOR=enabled", async () => {
    process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR = "enabled";
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";

    const { resolveDefaultBrowserCapacityMonitor } = await import("./consumer-defaults");
    const monitor = resolveDefaultBrowserCapacityMonitor();

    expect(monitor).not.toBeNull();
    expect(typeof monitor?.start).toBe("function");
    expect(typeof monitor?.stop).toBe("function");
    expect(typeof monitor?.tick).toBe("function");
    expect(typeof monitor?.lastState).toBe("function");
  });
});
