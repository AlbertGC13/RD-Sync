import { describe, expect, it, vi } from "vitest";

import {
  isCdpAvailable,
  ensureCdpBrowser,
  createEnsureBrowserFromEnv,
  createEnsureBrowserForBank,
  createAcquireBrowserSlotFromEnv,
  getBrowserCapacitySnapshotFromEnv,
  assertCdpLoopback,
  resolveBankBrowserEnv,
  BrowserSemaphore,
  SAFE_SUMMARY_MALFORMED_CDP_URL,
  SAFE_SUMMARY_NON_LOOPBACK_CDP,
  SAFE_SUMMARY_UNSUPPORTED_PROTOCOL,
  type FetchLike,
  type SpawnLike,
} from "./browser-runtime";

// ---------------------------------------------------------------------------
// Fake dependency builders
// ---------------------------------------------------------------------------

/**
 * Sequence-based fake fetch. Each call consumes the next behaviour in the
 * list; once exhausted, the last behaviour repeats. `true` → { ok: true },
 * `false` → { ok: false }, an Error → thrown (treated as unavailable).
 */
function makeFetchSequence(
  behaviours: Array<boolean | Error>,
): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const behaviour = behaviours[Math.min(index, behaviours.length - 1)];
    index++;
    if (behaviour instanceof Error) throw behaviour;
    return { ok: behaviour };
  };
  return { fetch, urls };
}

function makeSpawnTracker(): {
  spawn: SpawnLike;
  calls: string[];
  envs: Array<Record<string, string> | undefined>;
} {
  const calls: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const spawn: SpawnLike = (command, options) => {
    calls.push(command);
    envs.push(options?.env);
  };
  return { spawn, calls, envs };
}

/** No-op sleep — resolves immediately so tests never wait in real time. */
const noopSleep = async (): Promise<void> => {};

async function flushPendingMicrotasks(): Promise<void> {
  await Promise.resolve();
}

/** Fake clock that advances by `step` on each call. */
function makeFakeClock(start: number, step: number): () => number {
  let current = start;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

const CDP_URL = "http://127.0.0.1:9222";

// ---------------------------------------------------------------------------
// isCdpAvailable
// ---------------------------------------------------------------------------

describe("isCdpAvailable", () => {
  it("returns true when the CDP endpoint responds with ok", async () => {
    const { fetch, urls } = makeFetchSequence([true]);

    const result = await isCdpAvailable(CDP_URL, { fetch });

    expect(result).toBe(true);
    expect(urls).toEqual([`${CDP_URL}/json/version`]);
  });

  it("returns false when fetch throws (connection refused / network error)", async () => {
    const { fetch } = makeFetchSequence([new Error("ECONNREFUSED")]);

    const result = await isCdpAvailable(CDP_URL, { fetch });

    expect(result).toBe(false);
  });

  it("returns false when the response is not ok", async () => {
    const { fetch } = makeFetchSequence([false]);

    const result = await isCdpAvailable(CDP_URL, { fetch });

    expect(result).toBe(false);
  });

  it("rejects non-loopback URLs before any fetch is attempted", async () => {
    const { fetch, urls } = makeFetchSequence([true]);

    await expect(
      isCdpAvailable("http://10.0.0.5:9222", { fetch }),
    ).rejects.toThrow(SAFE_SUMMARY_NON_LOOPBACK_CDP);
    expect(urls).toEqual([]);
  });

  it("returns false on timeout when fetch never resolves but respects signal.abort (Fix D)", async () => {
    // A fetch that never resolves on its own, but rejects with an AbortError
    // when the passed signal aborts — mirroring real globalThis.fetch
    // behaviour. isCdpAvailable must abort it via its own AbortController and
    // return false promptly, without waiting for the (much longer) default
    // check timeout.
    const neverResolvingFetch: FetchLike = (_url, init) =>
      new Promise<{ ok: boolean }>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted"));
        });
      });

    const start = Date.now();
    const result = await isCdpAvailable(CDP_URL, {
      fetch: neverResolvingFetch,
      timeoutMs: 30,
    });
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    // Proves the short timeout (30ms) was honoured and the abort path fired —
    // the default check timeout is 2000ms, so a sub-1000ms return means the
    // fetch was aborted rather than left hanging until the test timed out.
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// ensureCdpBrowser
// ---------------------------------------------------------------------------

describe("ensureCdpBrowser — CDP already available", () => {
  it("returns ok without launching when CDP is already alive", async () => {
    const { fetch } = makeFetchSequence([true]);
    const { spawn, calls } = makeSpawnTracker();

    const result = await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      launchCommand: "./scripts/launch-bank-browser.sh",
      deps: { fetch, spawn, sleep: noopSleep, now: () => 0 },
    });

    expect(result).toEqual({ ok: true, launched: false });
    expect(calls).toEqual([]); // spawn never called
  });
});

describe("ensureCdpBrowser — CDP unavailable, no launch command", () => {
  it("returns a safe failure without spawning anything", async () => {
    const { fetch } = makeFetchSequence([false]);
    const { spawn, calls } = makeSpawnTracker();

    const result = await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      // launchCommand omitted
      deps: { fetch, spawn, sleep: noopSleep, now: () => 0 },
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("safeErrorSummary", "Bank browser is not running");
    expect(calls).toEqual([]); // spawn never called
  });

  it("rejects non-loopback URLs without fetching or spawning", async () => {
    const { fetch, urls } = makeFetchSequence([true]);
    const { spawn, calls } = makeSpawnTracker();

    const result = await ensureCdpBrowser({
      cdpUrl: "http://10.0.0.5:9222",
      launchCommand: "./scripts/launch-bank-browser.sh",
      deps: { fetch, spawn, sleep: noopSleep, now: () => 0 },
    });

    expect(result).toEqual({
      ok: false,
      launched: false,
      safeErrorSummary: SAFE_SUMMARY_NON_LOOPBACK_CDP,
    });
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("ensureCdpBrowser — CDP unavailable, launch command configured", () => {
  it("spawns the launch command and polls until CDP becomes available", async () => {
    // First check (pre-launch) fails, two poll checks fail, third poll succeeds.
    const { fetch, urls } = makeFetchSequence([false, false, false, true]);
    const { spawn, calls } = makeSpawnTracker();

    const result = await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      launchCommand: "./scripts/launch-bank-browser.sh",
      readyTimeoutMs: 10_000,
      pollIntervalMs: 100,
      deps: { fetch, spawn, sleep: noopSleep, now: () => 0 },
    });

    expect(result).toEqual({ ok: true, launched: true });
    expect(calls).toEqual(["./scripts/launch-bank-browser.sh"]);
    // 1 pre-launch check + 3 poll checks = 4 fetch calls
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u === `${CDP_URL}/json/version`)).toBe(true);
  });

  it("returns a safe timeout failure when CDP never becomes ready", async () => {
    const { fetch } = makeFetchSequence([false]);
    const { spawn, calls } = makeSpawnTracker();
    const now = makeFakeClock(0, 400);

    const result = await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      launchCommand: "./scripts/launch-bank-browser.sh",
      readyTimeoutMs: 1_000,
      pollIntervalMs: 100,
      deps: { fetch, spawn, sleep: noopSleep, now },
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("safeErrorSummary", "Bank browser did not become ready in time");
    expect(result).toHaveProperty("launched", true);
    // spawn was called once
    expect(calls).toEqual(["./scripts/launch-bank-browser.sh"]);
  });

  it("returns a safe failure when spawn throws (never leaks command details)", async () => {
    const { fetch } = makeFetchSequence([false]);
    const failingSpawn: SpawnLike = () => {
      throw new Error("ENOENT: command not found at /some/secret/path");
    };

    const result = await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      launchCommand: "./scripts/launch-bank-browser.sh",
      deps: { fetch, spawn: failingSpawn, sleep: noopSleep, now: () => 0 },
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("launched", true);
    // The safe summary must NOT contain the spawn error message or path.
    expect(result).toHaveProperty("safeErrorSummary", "Bank browser is not running");
    const summary = (result as { safeErrorSummary: string }).safeErrorSummary;
    expect(summary).not.toContain("ENOENT");
    expect(summary).not.toContain("/some/secret/path");
  });
});

// ---------------------------------------------------------------------------
// ensureCdpBrowser — concurrent launch coalescing (Fix A)
// ---------------------------------------------------------------------------

describe("ensureCdpBrowser — concurrent calls only spawn once (process-level mutex)", () => {
  it("two concurrent calls with the same cdpUrl share a single launch attempt", async () => {
    // Pre-launch check fails, then the first poll succeeds → one spawn.
    const { fetch, urls } = makeFetchSequence([false, true]);
    const { spawn, calls } = makeSpawnTracker();

    // Both calls are dispatched before either resolves so they overlap. They
    // share the same fetch sequence and spawn tracker (proving only one call
    // actually runs the launch flow).
    const [resultA, resultB] = await Promise.all([
      ensureCdpBrowser({
        cdpUrl: CDP_URL,
        launchCommand: "./scripts/launch-bank-browser.sh",
        deps: { fetch, spawn, sleep: noopSleep, now: () => 0 },
      }),
      ensureCdpBrowser({
        cdpUrl: CDP_URL,
        launchCommand: "./scripts/launch-bank-browser.sh",
        deps: { fetch, spawn, sleep: noopSleep, now: () => 0 },
      }),
    ]);

    // The browser is launched exactly once — the core resilience guarantee.
    expect(calls).toEqual(["./scripts/launch-bank-browser.sh"]);
    expect(calls).toHaveLength(1);
    // Both callers observe the same successful result.
    expect(resultA).toEqual({ ok: true, launched: true });
    expect(resultB).toEqual({ ok: true, launched: true });
    // Only the single in-flight operation consumed fetches:
    // 1 pre-launch check (false) + 1 poll check (true) = 2 fetch calls.
    expect(urls).toHaveLength(2);
  });

  it("coalesces by cdpUrl — a different endpoint launches independently", async () => {
    // Two different CDP endpoints must NOT share a launch attempt.
    const { fetch: fetchA } = makeFetchSequence([false, true]);
    const { spawn: spawnA, calls: callsA } = makeSpawnTracker();
    const { fetch: fetchB } = makeFetchSequence([false, true]);
    const { spawn: spawnB, calls: callsB } = makeSpawnTracker();

    const OTHER_CDP_URL = "http://127.0.0.1:9333";

    await Promise.all([
      ensureCdpBrowser({
        cdpUrl: CDP_URL,
        launchCommand: "./scripts/launch-bank-browser.sh",
        deps: { fetch: fetchA, spawn: spawnA, sleep: noopSleep, now: () => 0 },
      }),
      ensureCdpBrowser({
        cdpUrl: OTHER_CDP_URL,
        launchCommand: "./scripts/launch-bank-browser.sh",
        deps: { fetch: fetchB, spawn: spawnB, sleep: noopSleep, now: () => 0 },
      }),
    ]);

    // Each endpoint launched its own browser — the mutex is keyed by cdpUrl.
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
  });

  it("a later call re-checks CDP after the in-flight launch completes", async () => {
    // First launch: pre-launch fails, poll succeeds.
    const { fetch: fetch1 } = makeFetchSequence([false, true]);
    const { spawn: spawn1, calls: calls1 } = makeSpawnTracker();

    await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      launchCommand: "./scripts/launch-bank-browser.sh",
      deps: { fetch: fetch1, spawn: spawn1, sleep: noopSleep, now: () => 0 },
    });
    expect(calls1).toHaveLength(1);

    // Second, sequential call: the mutex entry was cleared on completion, so
    // this runs its own check. CDP is now alive (fetch returns ok) → no spawn.
    const { fetch: fetch2 } = makeFetchSequence([true]);
    const { spawn: spawn2, calls: calls2 } = makeSpawnTracker();

    const result = await ensureCdpBrowser({
      cdpUrl: CDP_URL,
      launchCommand: "./scripts/launch-bank-browser.sh",
      deps: { fetch: fetch2, spawn: spawn2, sleep: noopSleep, now: () => 0 },
    });

    expect(result).toEqual({ ok: true, launched: false });
    expect(calls2).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createEnsureBrowserFromEnv
// ---------------------------------------------------------------------------

describe("createEnsureBrowserFromEnv", () => {
  it("returns undefined when auto-launch is disabled", () => {
    const seam = createEnsureBrowserFromEnv({
      RD_SYNC_CDP_URL: CDP_URL,
      // RD_SYNC_BANK_BROWSER_AUTO_LAUNCH not set
    });
    expect(seam).toBeUndefined();
  });

  it("returns undefined when auto-launch is enabled but CDP_URL is missing", () => {
    const seam = createEnsureBrowserFromEnv({
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      // RD_SYNC_CDP_URL not set
    });
    expect(seam).toBeUndefined();
  });

  it("returns a seam function when auto-launch is enabled and CDP_URL is set", () => {
    const seam = createEnsureBrowserFromEnv({
      RD_SYNC_CDP_URL: CDP_URL,
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND: "./scripts/launch-bank-browser.sh",
    });
    expect(typeof seam).toBe("function");
  });

  it("returns undefined when auto-launch is set to a value other than 'enabled'", () => {
    const seam = createEnsureBrowserFromEnv({
      RD_SYNC_CDP_URL: CDP_URL,
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "true",
    });
    expect(seam).toBeUndefined();
  });
});

describe("assertCdpLoopback", () => {
  it("accepts origin-only loopback http endpoints", () => {
    for (const cdpUrl of [
      "http://127.0.0.1:9222",
      "http://localhost:9222",
      "http://[::1]:9222",
    ]) {
      expect(() => assertCdpLoopback(cdpUrl)).not.toThrow();
    }
  });

  it("rejects unsafe CDP URLs with fixed safe summaries", () => {
    expect(() => assertCdpLoopback("http://10.0.0.5:9222")).toThrow(
      SAFE_SUMMARY_NON_LOOPBACK_CDP,
    );
    for (const unsupportedUrl of ["ftp://127.0.0.1:9222", "ws://127.0.0.1:9222"]) {
      expect(() => assertCdpLoopback(unsupportedUrl)).toThrow(
        SAFE_SUMMARY_UNSUPPORTED_PROTOCOL,
      );
    }
    expect(() => assertCdpLoopback("not-a-url")).toThrow(
      SAFE_SUMMARY_MALFORMED_CDP_URL,
    );
    for (const invalidUrl of [
      "http://127.0.0.1:9222/json/version",
      "http://user@127.0.0.1:9222",
      "http://127.0.0.1:9222?probe=1",
      "http://127.0.0.1:9222#devtools",
    ]) {
      expect(() => assertCdpLoopback(invalidUrl)).toThrow(
        SAFE_SUMMARY_MALFORMED_CDP_URL,
      );
    }
  });
});

describe("resolveBankBrowserEnv", () => {
  it("uses per-bank CDP, then falls back to non-blank global CDP", () => {
    expect(resolveBankBrowserEnv("popular", {
      RD_SYNC_CDP_URL: "http://127.0.0.1:9333",
    }).cdpUrl).toBe("http://127.0.0.1:9333");
    expect(resolveBankBrowserEnv("popular", {
      RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9222",
      RD_SYNC_CDP_URL: "http://127.0.0.1:9333",
    }).cdpUrl).toBe("http://127.0.0.1:9222");
    expect(resolveBankBrowserEnv("popular", {
      RD_SYNC_BANK_POPULAR_CDP_URL: "",
      RD_SYNC_CDP_URL: "http://127.0.0.1:9333",
    }).cdpUrl).toBe("http://127.0.0.1:9333");
  });
});

describe("createEnsureBrowserForBank", () => {
  it("passes bank identity through env and polls the same per-bank CDP URL", async () => {
    const bankCdpUrl = "http://127.0.0.1:9333";
    const { fetch, urls } = makeFetchSequence([false, true]);
    const { spawn, calls, envs } = makeSpawnTracker();
    const seam = createEnsureBrowserForBank(
      "popular",
      {
        RD_SYNC_BANK_POPULAR_CDP_URL: bankCdpUrl,
        RD_SYNC_CDP_URL: CDP_URL,
        RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
        RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND: "./scripts/launch-bank-browser.sh",
      },
      { fetch, spawn, sleep: noopSleep, now: () => 0 },
    );

    const result = await seam?.();

    expect(result).toEqual({ ok: true, launched: true });
    expect(calls).toEqual(["./scripts/launch-bank-browser.sh"]);
    expect(envs).toEqual([{ BANK_CODE: "popular" }]);
    expect(urls).toEqual([
      `${bankCdpUrl}/json/version`,
      `${bankCdpUrl}/json/version`,
    ]);
  });

  it("fails explicitly for invalid bank codes", () => {
    expect(() =>
      createEnsureBrowserForBank("popular;echo", {
        RD_SYNC_BANK_POPULAR_CDP_URL: CDP_URL,
        RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      }),
    ).toThrow("Invalid bank code for browser launcher");
  });
});

// ---------------------------------------------------------------------------
// BrowserSemaphore — bounded concurrency backpressure
// ---------------------------------------------------------------------------

describe("BrowserSemaphore", () => {
  it("acquires, queues, exposes capacity, and releases the next waiter", async () => {
    const sem = new BrowserSemaphore(1, 2);
    const r1 = await sem.acquire();
    expect(r1.kind).toBe("acquired");
    expect(sem.capacity()).toEqual({ active: 1, queueDepth: 0, max: 1 });

    let secondResolved = false;
    const r2Promise = sem.acquire().then((r) => {
      secondResolved = true;
      return r;
    });

    await flushPendingMicrotasks();
    expect(secondResolved).toBe(false);
    expect(sem.capacity()).toEqual({ active: 1, queueDepth: 1, max: 1 });

    if (r1.kind === "acquired") await r1.release();

    const r2 = await r2Promise;
    expect(secondResolved).toBe(true);
    expect(r2.kind).toBe("acquired");
    if (r2.kind === "acquired") await r2.release();
    expect(sem.capacity()).toEqual({ active: 0, queueDepth: 0, max: 1 });
  });

  it("throttles when the bounded queue is full and increments throttleCount", async () => {
    const sem = new BrowserSemaphore(1, 1);
    expect(sem.throttleCount).toBe(0);

    const r1 = await sem.acquire();
    const r2Promise = sem.acquire();
    await flushPendingMicrotasks();

    const throttled = await sem.acquire();
    expect(throttled.kind).toBe("throttled");
    expect(sem.throttleCount).toBe(1);

    const throttled2 = await sem.acquire();
    expect(throttled2.kind).toBe("throttled");
    expect(sem.throttleCount).toBe(2);

    if (r1.kind === "acquired") await r1.release();
    const r2 = await r2Promise;
    if (r2.kind === "acquired") await r2.release();
  });

  it("release is idempotent and max=0 immediately throttles", async () => {
    const sem = new BrowserSemaphore(1);
    const r1 = await sem.acquire();
    expect(r1.kind).toBe("acquired");

    if (r1.kind === "acquired") {
      await r1.release();
      // Second release should not throw or double-decrement
      await r1.release();
    }

    expect(sem.capacity()).toEqual({ active: 0, queueDepth: 0, max: 1 });

    const disabled = new BrowserSemaphore(0);
    const result = await disabled.acquire();
    expect(result.kind).toBe("throttled");
    expect(disabled.throttleCount).toBe(1);
  });

  it("reads max concurrency from env and falls back for missing or invalid values", () => {
    expect(BrowserSemaphore.fromEnv({
      RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY: "3",
    }).capacity().max).toBe(3);
    expect(BrowserSemaphore.fromEnv({}).capacity().max).toBe(2);
    expect(BrowserSemaphore.fromEnv({
      RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY: "not-a-number",
    }).capacity().max).toBe(2);
  });

  it("wakes the first queued waiter on release (FIFO ordering)", async () => {
    const sem = new BrowserSemaphore(1, 5);
    const r1 = await sem.acquire();

    const r2Promise = sem.acquire();
    const r3Promise = sem.acquire();
    await flushPendingMicrotasks();

    if (r1.kind === "acquired") await r1.release();
    const r2 = await r2Promise;
    expect(r2.kind).toBe("acquired");

    let r3Resolved = false;
    r3Promise.then(() => { r3Resolved = true; });
    await flushPendingMicrotasks();
    expect(r3Resolved).toBe(false);

    // Release r2 — r3 wakes.
    if (r2.kind === "acquired") await r2.release();
    const r3 = await r3Promise;
    expect(r3.kind).toBe("acquired");
    if (r3.kind === "acquired") await r3.release();
  });

  it("times out queued acquire attempts without waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const sem = new BrowserSemaphore(1, 1);
      const r1 = await sem.acquire();
      expect(r1.kind).toBe("acquired");

      const queued = sem.acquire({ timeoutMs: 25 });
      expect(sem.capacity()).toEqual({ active: 1, queueDepth: 1, max: 1 });

      await vi.advanceTimersByTimeAsync(25);
      await expect(queued).resolves.toEqual({ kind: "throttled" });
      expect(sem.capacity()).toEqual({ active: 1, queueDepth: 0, max: 1 });
      expect(sem.throttleCount).toBe(1);

      if (r1.kind === "acquired") await r1.release();
      expect(sem.capacity()).toEqual({ active: 0, queueDepth: 0, max: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// getBrowserCapacitySnapshotFromEnv — samples the REAL shared semaphore
// ---------------------------------------------------------------------------

describe("getBrowserCapacitySnapshotFromEnv", () => {
  it("reflects the live capacity and throttleCount of the shared singleton, not a fresh instance", async () => {
    const env = {
      RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY: "1",
      RD_SYNC_BANK_BROWSER_QUEUE_LIMIT: "0",
    };

    // Drive the same env-keyed singleton that createAcquireBrowserSlotFromEnv
    // uses, so we can assert the snapshot reflects real, live state.
    const acquire = createAcquireBrowserSlotFromEnv(env);

    const before = getBrowserCapacitySnapshotFromEnv(env);
    expect(before).toEqual({ active: 0, queueDepth: 0, max: 1, throttleCount: 0 });

    const held = await acquire();
    expect(held.kind).toBe("acquired");

    const duringHold = getBrowserCapacitySnapshotFromEnv(env);
    expect(duringHold.active).toBe(1);

    // queueLimit=0 means the next acquire immediately throttles.
    const throttled = await acquire();
    expect(throttled.kind).toBe("throttled");

    const afterThrottle = getBrowserCapacitySnapshotFromEnv(env);
    expect(afterThrottle).toEqual({ active: 1, queueDepth: 0, max: 1, throttleCount: 1 });

    if (held.kind === "acquired") await held.release();
  });
});
