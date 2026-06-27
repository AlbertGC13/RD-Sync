import { describe, expect, it } from "vitest";

import type { IngestionScraper } from "../../worker/queues";
import {
  bankAdapterRegistry,
  createBankAdapterRegistry,
  type BankAdapter,
} from "./registry";

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

describe("bankAdapterRegistry — default instance (Popular registered in PR1)", () => {
  it("resolves the Popular adapter by its canonical bankCode", () => {
    const adapter = bankAdapterRegistry.get("popular");

    expect(adapter).toBeDefined();
    expect(adapter?.bankCode).toBe("popular");
  });

  it("exposes only Popular as supported in PR1 (Banreservas/BHD land in PR5)", () => {
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
