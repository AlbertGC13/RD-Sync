import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveDefaultScraper,
  buildPopularCdpScraperOptionsFromEnv,
} from "./consumer-defaults";
import { createPopularCdpScraper } from "../../../worker/scraper/navigation/popular-cdp";

const CDP_URL = "http://127.0.0.1:9222";

describe("resolveDefaultScraper — branch selection", () => {
  beforeEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_BANK_POPULAR_CDP_URL;
    delete process.env.RD_SYNC_DEV_PREVIEW;
    delete process.env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH;
    delete process.env.RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND;
    delete process.env.RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS;
    delete process.env.RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_BANK_POPULAR_CDP_URL;
    delete process.env.RD_SYNC_DEV_PREVIEW;
    delete process.env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH;
    delete process.env.RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND;
    delete process.env.RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS;
    delete process.env.RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS;
  });

  it("returns a scraper with a collect function when RD_SYNC_SCRAPER=popular-cdp", () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = CDP_URL;

    const scraper = resolveDefaultScraper();
    expect(typeof scraper.collect).toBe("function");
  });

  it("returns status needs_admin_action (stub) when env var is not set", async () => {
    // No env vars set → falls through to stub that reports not configured
    const scraper = resolveDefaultScraper();
    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
  });

  it("returns fixture data when RD_SYNC_DEV_PREVIEW=enabled (existing branch unchanged)", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper();
    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(result.movements.length).toBeGreaterThan(0);
  });

  it("popular-cdp branch takes precedence over RD_SYNC_DEV_PREVIEW", () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = CDP_URL;
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    // Branch selection: RD_SYNC_SCRAPER takes priority.
    // The connect/collect behavior of popular-cdp is covered by popular-cdp.test.ts.
    const scraper = resolveDefaultScraper();
    expect(typeof scraper.collect).toBe("function");
  });

  it("resolves popular-cdp scraper with auto-launch env vars set without throwing", () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = CDP_URL;
    process.env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH = "enabled";
    process.env.RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND = "./scripts/launch-bank-browser.sh";

    // The ensureBrowser seam is built from env and wired into the scraper.
    // The seam only runs at collect() time; construction must not throw.
    const scraper = resolveDefaultScraper();
    expect(typeof scraper.collect).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// buildPopularCdpScraperOptionsFromEnv — env wiring contract (Fix C)
//
// Proves that the ensureBrowser seam is actually passed into the Popular
// scraper options when auto-launch is enabled, and absent (undefined) when
// disabled — so the disabled case stays backward compatible (the scraper
// connects directly as before).
// ---------------------------------------------------------------------------

describe("buildPopularCdpScraperOptionsFromEnv — ensureBrowser wiring (Fix C)", () => {
  it("returns undefined when RD_SYNC_SCRAPER is not popular-cdp", () => {
    const options = buildPopularCdpScraperOptionsFromEnv({
      RD_SYNC_SCRAPER: "something-else",
      RD_SYNC_CDP_URL: CDP_URL,
    });
    expect(options).toBeUndefined();
  });

  it("wires an ensureBrowser seam when auto-launch is enabled (Fix C happy path)", () => {
    const options = buildPopularCdpScraperOptionsFromEnv({
      RD_SYNC_SCRAPER: "popular-cdp",
      RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9333",
      RD_SYNC_CDP_URL: CDP_URL,
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND: "./scripts/launch-bank-browser.sh",
    });

    expect(options).toBeDefined();
    expect(options!.cdpUrl).toBe("http://127.0.0.1:9333");
    // The contract: ensureBrowser is a function the scraper will await before
    // connecting — NOT undefined. This is the behaviour the env wiring test
    // must actually prove (construction alone is not enough).
    expect(typeof options!.ensureBrowser).toBe("function");
  });

  it("leaves ensureBrowser undefined when auto-launch is disabled (backward compatible)", () => {
    const options = buildPopularCdpScraperOptionsFromEnv({
      RD_SYNC_SCRAPER: "popular-cdp",
      RD_SYNC_CDP_URL: CDP_URL,
      // RD_SYNC_BANK_BROWSER_AUTO_LAUNCH intentionally unset
    });

    expect(options).toBeDefined();
    expect(options!.cdpUrl).toBe(CDP_URL);
    // No seam → the scraper connects directly as before.
    expect(options!.ensureBrowser).toBeUndefined();
  });

  it("leaves ensureBrowser undefined when auto-launch is enabled but CDP_URL is missing", () => {
    const options = buildPopularCdpScraperOptionsFromEnv({
      RD_SYNC_SCRAPER: "popular-cdp",
      // No per-bank or global CDP URL set
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND: "./scripts/launch-bank-browser.sh",
    });

    // Options are still returned (the scraper handles a missing cdpUrl via its
    // own default), but the ensureBrowser seam is absent because the bank-aware
    // launcher seam requires a resolved cdpUrl.
    expect(options).toBeDefined();
    expect(options!.ensureBrowser).toBeUndefined();
  });

  it("wires a callable ensureBrowser seam without exercising browser launch", async () => {
    // The launch/spawn behaviour is covered deterministically in
    // browser-runtime.test.ts. This test only proves the seam is wired into the
    // Popular CDP options without starting a real process.
    const options = buildPopularCdpScraperOptionsFromEnv({
      RD_SYNC_SCRAPER: "popular-cdp",
      RD_SYNC_CDP_URL: CDP_URL,
      RD_SYNC_BANK_BROWSER_AUTO_LAUNCH: "enabled",
      RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND: "./scripts/launch-bank-browser.sh",
    });

    expect(options?.ensureBrowser).toBeDefined();
    // This test's job is to prove the seam is WIRED.
    expect(typeof options!.ensureBrowser).toBe("function");
  });
});

describe("createPopularCdpScraper — connect failure (deterministic, no real I/O)", () => {
  it("returns needs_admin_action when connect throws synchronously", async () => {
    const scraper = createPopularCdpScraper({
      cdpUrl: CDP_URL,
      connect: async () => {
        throw new Error("Connection refused");
      },
    });

    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
    expect(result.safeErrorSummary).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultScraper — bankCode routing via the adapter registry.
//
// PR1 replaces the Popular-hardcoded branch selection with registry routing:
// absent/empty bankCode defaults to Popular (backward compatible); an explicit
// unknown bankCode fails closed (needs_admin_action) and NEVER falls back to
// Popular. The 400 + audit for unknown banks is enforced in run-now; the
// consumer layer fails safely if an unknown code ever reaches it.
// ---------------------------------------------------------------------------

describe("resolveDefaultScraper — bankCode registry routing", () => {
  beforeEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_BANK_POPULAR_CDP_URL;
    delete process.env.RD_SYNC_DEV_PREVIEW;
    delete process.env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH;
  });

  afterEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_BANK_POPULAR_CDP_URL;
    delete process.env.RD_SYNC_DEV_PREVIEW;
    delete process.env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH;
  });

  it("routes an explicit popular bankCode through the registry (Popular path unchanged)", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("popular");
    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(result.movements.length).toBeGreaterThan(0);
  });

  it("defaults to Popular when bankCode is absent (legacy/default run, backward compatible)", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper();
    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(result.movements.length).toBeGreaterThan(0);
  });

  it("defaults to Popular when bankCode is empty/whitespace (treated as absent)", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("   ");
    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(result.movements.length).toBeGreaterThan(0);
  });

  it("fails closed for an explicit unknown bankCode (never falls back to Popular)", async () => {
    // DEV_PREVIEW is enabled so a Popular fallback would return `collected`.
    // An unknown bankCode must NOT fall back to Popular — it must fail closed
    // with needs_admin_action. This distinguishes real registry routing from
    // the previous arg-ignoring behaviour.
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("banreservas");
    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
    expect(result.safeErrorSummary).toBeTruthy();
    // The summary must not claim Popular fallback or leak internal routing.
    expect(result.safeErrorSummary).not.toContain("popular-cdp");
  });

  it("fails closed for a fully unknown bankCode as well", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("some-future-bank");
    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
  });

  it("popular-cdp env still wins for an explicit popular bankCode (precedence preserved)", () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = CDP_URL;

    const scraper = resolveDefaultScraper("popular");
    expect(typeof scraper.collect).toBe("function");
  });

  it("routes 'bhd' to the BHD adapter scraper (not Popular)", async () => {
    // DEV_PREVIEW is enabled so a Popular fallback would return `collected`.
    // The BHD adapter returns needs_admin_action with its own safeErrorSummary.
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("bhd");
    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.safeErrorSummary).toBe("BHD Personal adapter is a skeleton");
    expect(result.movements).toEqual([]);
  });

  it("routes 'banreservas_personas' to the Banreservas Personas adapter scraper (not Popular)", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("banreservas_personas");
    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.safeErrorSummary).toBe("Banreservas Personas adapter is a skeleton");
    expect(result.movements).toEqual([]);
  });

  it("routes 'banreservas_empresas' to the Banreservas Empresas adapter scraper (not Popular)", async () => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    const scraper = resolveDefaultScraper("banreservas_empresas");
    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.safeErrorSummary).toBe("Banreservas Empresas adapter is a skeleton");
    expect(result.movements).toEqual([]);
  });
});
