import { describe, expect, it, vi } from "vitest";

import type { IngestionScraper } from "../../worker/queues";
import {
  buildPopularCdpScraperOptionsFromEnv,
  bankAdapterRegistry,
  createBankAdapterRegistry,
  type BankAdapter,
} from "./registry";
import { popularPortalConfig } from "./popular-portal";

const stubScraper: IngestionScraper = {
  collect: async () => ({ status: "collected", movements: [] }),
};

function fakeAdapter(bankCode: string): BankAdapter {
  return {
    bankCode,
    createScraper: () => stubScraper,
    createAutoLoginStrategy: () => {
      throw new Error("not implemented");
    },
  };
}

function makePopularLoginPage(unsafeSelector?: string) {
  let url: string = popularPortalConfig.baseUrl;
  const visible = new Set<string>([
    popularPortalConfig.usernameSelector,
    popularPortalConfig.passwordSelector,
    popularPortalConfig.submitSelector,
  ]);
  if (unsafeSelector) visible.add(unsafeSelector);

  const fill = vi.fn();
  const click = vi.fn(async () => {
    url = `${popularPortalConfig.baseUrl}${popularPortalConfig.dashboardPathIndicator}`;
  });

  return {
    page: {
      currentUrl: async () => url,
      hasVisibleSelector: async (selector: string) => visible.has(selector),
      fill,
      click,
    },
    fill,
    click,
  };
}

describe("createBankAdapterRegistry — factory keyed by bankCode", () => {
  it("returns the adapter registered under a bankCode", () => {
    const registry = createBankAdapterRegistry([fakeAdapter("popular")]);

    expect(registry.get("popular")?.bankCode).toBe("popular");
  });

  it("returns undefined for a bankCode with no registered adapter (fail-closed, never Popular fallback)", () => {
    const registry = createBankAdapterRegistry([fakeAdapter("popular")]);

    expect(registry.get("banreservas")).toBeUndefined();
    expect(registry.get("bhd")).toBeUndefined();
  });

  it("derives supportedBankCodes from the registered adapters (no separate whitelist to drift)", () => {
    const registry = createBankAdapterRegistry(
      [fakeAdapter("popular"), fakeAdapter("banreservas")],
      {},
    );

    expect(registry.supportedBankCodes()).toEqual(["popular", "banreservas"]);
  });
});

describe("createBankAdapterRegistry — CDP endpoint uniqueness guard (MEDIUM-2)", () => {
  it("throws when two banks share the same explicit per-bank CDP port", () => {
    expect(() =>
      createBankAdapterRegistry([fakeAdapter("popular"), fakeAdapter("banreservas")], {
        RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9222",
        RD_SYNC_BANK_BANRESERVAS_CDP_URL: "http://127.0.0.1:9222",
      }),
    ).toThrow(/CDP endpoint collision/);
  });

  it("throws when two banks both inherit the single global RD_SYNC_CDP_URL fallback", () => {
    expect(() =>
      createBankAdapterRegistry([fakeAdapter("popular"), fakeAdapter("banreservas")], {
        RD_SYNC_CDP_URL: "http://127.0.0.1:9222",
      }),
    ).toThrow(/CDP endpoint collision/);
  });

  it("treats loopback host aliases on the same port as a collision", () => {
    expect(() =>
      createBankAdapterRegistry([fakeAdapter("popular"), fakeAdapter("banreservas")], {
        RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9222",
        RD_SYNC_BANK_BANRESERVAS_CDP_URL: "http://localhost:9222",
      }),
    ).toThrow(/CDP endpoint collision/);
  });

  it("allows banks with distinct loopback CDP ports", () => {
    expect(() =>
      createBankAdapterRegistry([fakeAdapter("popular"), fakeAdapter("banreservas")], {
        RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9222",
        RD_SYNC_BANK_BANRESERVAS_CDP_URL: "http://127.0.0.1:9333",
      }),
    ).not.toThrow();
  });

  it("does not flag unconfigured banks (empty resolution falls back to the shared default later)", () => {
    // No CDP env at all — both resolve to "" here and only adopt DEFAULT_CDP_URL
    // at scraper construction. The guard must not block registration.
    expect(() =>
      createBankAdapterRegistry([fakeAdapter("popular"), fakeAdapter("banreservas")], {}),
    ).not.toThrow();
  });
});

describe("bankAdapterRegistry — default instance", () => {
  it("resolves the Popular adapter by its canonical bankCode", () => {
    const adapter = bankAdapterRegistry.get("popular");

    expect(adapter).toBeDefined();
    expect(adapter?.bankCode).toBe("popular");
  });

  it("exposes only the currently registered Popular adapter", () => {
    expect(bankAdapterRegistry.supportedBankCodes()).toEqual(["popular"]);
  });

  it("returns undefined for an explicit unknown bankCode (never falls back to Popular)", () => {
    expect(bankAdapterRegistry.get("banreservas")).toBeUndefined();
    expect(bankAdapterRegistry.get("bhd")).toBeUndefined();
    expect(bankAdapterRegistry.get("unknown-bank")).toBeUndefined();
  });

  it("the Popular adapter's createScraper yields a usable IngestionScraper (lazy, no env read at import)", () => {
    const adapter = bankAdapterRegistry.get("popular");
    expect(adapter).toBeDefined();

    const scraper = adapter!.createScraper();
    expect(typeof scraper.collect).toBe("function");
  });
});

describe("buildPopularCdpScraperOptionsFromEnv — production backpressure wiring", () => {
  it("wires the browser semaphore into the Popular CDP scraper options", () => {
    const options = buildPopularCdpScraperOptionsFromEnv({
      RD_SYNC_SCRAPER: "popular-cdp",
    });

    expect(typeof options?.acquireBrowserSlot).toBe("function");
  });

});

describe("bankAdapterRegistry — Popular auto-login strategy", () => {
  it("uses configured selectors and outcomes in an offline fixture, not as independent live-surface proof", async () => {
    const strategy = bankAdapterRegistry.get("popular")!.createAutoLoginStrategy();
    const { page, fill, click } = makePopularLoginPage();

    await expect(strategy.autoLogin({
      credential: { bankCode: "popular", username: "bank-user", password: "bank-password" },
      page,
    })).resolves.toEqual({ status: "succeeded" });

    expect(fill.mock.calls).toEqual([
      [popularPortalConfig.usernameSelector, "bank-user"],
      [popularPortalConfig.passwordSelector, "bank-password"],
    ]);
    expect(click).toHaveBeenCalledWith(popularPortalConfig.submitSelector);
  });

  it.each([
    ["token challenge", popularPortalConfig.mfaIndicatorSelector, "protected_flow"],
    ["modal", popularPortalConfig.incompatibleFlowSelector, "incompatible_flow"],
  ] as const)("fails closed for a visible Popular %s without submitting credentials", async (_name, unsafeSelector, reason) => {
    const strategy = bankAdapterRegistry.get("popular")!.createAutoLoginStrategy();
    const { page, fill, click } = makePopularLoginPage(unsafeSelector);

    await expect(strategy.autoLogin({
      credential: { bankCode: "popular", username: "bank-user", password: "bank-password" },
      page,
    })).resolves.toMatchObject({ status: "needs_admin_action", reason });

    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
