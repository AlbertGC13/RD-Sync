import { describe, expect, it } from "vitest";

import { bankAdapterRegistry } from "../modules/bank-adapters/registry";
import {
  DEFAULT_RUN_NOW_BANK_CODE,
  SUPPORTED_RUN_NOW_BANK_CODES,
  bankDisplayName,
  isSupportedRunNowBankCode,
} from "./banks";

describe("SUPPORTED_RUN_NOW_BANK_CODES — canonical bankCode whitelist (PR5.2)", () => {
  it("exposes all four supported bank codes", () => {
    expect(SUPPORTED_RUN_NOW_BANK_CODES).toEqual([
      "popular",
      "bhd",
      "banreservas_personas",
      "banreservas_empresas",
    ]);
    expect(DEFAULT_RUN_NOW_BANK_CODE).toBe("popular");
  });

  it("recognises all four bank codes as supported", () => {
    expect(isSupportedRunNowBankCode("popular")).toBe(true);
    expect(isSupportedRunNowBankCode("bhd")).toBe(true);
    expect(isSupportedRunNowBankCode("banreservas_personas")).toBe(true);
    expect(isSupportedRunNowBankCode("banreservas_empresas")).toBe(true);
  });

  it("rejects unknown and partial-match bank codes", () => {
    expect(isSupportedRunNowBankCode("banreservas")).toBe(false);
    expect(isSupportedRunNowBankCode("bhd_personal")).toBe(false);
    expect(isSupportedRunNowBankCode("")).toBe(false);
    expect(isSupportedRunNowBankCode("unknown")).toBe(false);
  });
});

describe("SUPPORTED_RUN_NOW_BANK_CODES — registry parity (derived from registry presence)", () => {
  // The UI-facing whitelist in banks.ts is a client-safe mirror of the
  // server-side adapter registry (banks.ts cannot import the registry without
  // pulling worker CDP deps into client bundles). This guard keeps the mirror
  // in sync with the canonical registry so the UI affordance and the backend
  // run-now enforcement never drift.
  it("matches the bank adapter registry's supportedBankCodes exactly", () => {
    expect([...SUPPORTED_RUN_NOW_BANK_CODES]).toEqual([
      ...bankAdapterRegistry.supportedBankCodes(),
    ]);
  });
});

describe("bankDisplayName — operator-facing labels (no raw underscored codes)", () => {
  it("maps supported bank codes to professional Spanish display names", () => {
    expect(bankDisplayName("popular")).toBe("Banco Popular");
    expect(bankDisplayName("bhd")).toBe("BHD");
    expect(bankDisplayName("banreservas_personas")).toBe("Banreservas Personas");
    expect(bankDisplayName("banreservas_empresas")).toBe("Banreservas Empresas");
  });

  it("falls back to the raw bankId when no display name is registered", () => {
    expect(bankDisplayName("unknown-bank")).toBe("unknown-bank");
  });
});
