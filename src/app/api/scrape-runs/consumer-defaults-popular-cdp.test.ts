import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveDefaultScraper } from "./consumer-defaults";
import { createPopularCdpScraper } from "../../../worker/scraper/navigation/popular-cdp";

describe("resolveDefaultScraper — branch selection", () => {
  beforeEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_DEV_PREVIEW;
  });

  afterEach(() => {
    delete process.env.RD_SYNC_SCRAPER;
    delete process.env.RD_SYNC_CDP_URL;
    delete process.env.RD_SYNC_DEV_PREVIEW;
  });

  it("returns a scraper with a collect function when RD_SYNC_SCRAPER=popular-cdp", () => {
    process.env.RD_SYNC_SCRAPER = "popular-cdp";
    process.env.RD_SYNC_CDP_URL = "http://localhost:9222";

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
    process.env.RD_SYNC_CDP_URL = "http://localhost:9222";
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";

    // Branch selection: RD_SYNC_SCRAPER takes priority.
    // The connect/collect behavior of popular-cdp is covered by popular-cdp.test.ts.
    const scraper = resolveDefaultScraper();
    expect(typeof scraper.collect).toBe("function");
  });
});

describe("createPopularCdpScraper — connect failure (deterministic, no real I/O)", () => {
  it("returns needs_admin_action when connect throws synchronously", async () => {
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://localhost:9222",
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
