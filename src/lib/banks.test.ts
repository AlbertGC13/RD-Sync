import { describe, expect, it } from "vitest";

import { bankAdapterRegistry } from "../modules/bank-adapters/registry";
import {
  DEFAULT_RUN_NOW_BANK_CODE,
  SUPPORTED_RUN_NOW_BANK_CODES,
  isSupportedRunNowBankCode,
  scrapeRunStatusLabel,
} from "./banks";

describe("SUPPORTED_RUN_NOW_BANK_CODES — canonical bankCode whitelist", () => {
  it("exposes Popular as the only currently supported bank code in PR1", () => {
    expect(SUPPORTED_RUN_NOW_BANK_CODES).toEqual(["popular"]);
    expect(DEFAULT_RUN_NOW_BANK_CODE).toBe("popular");
  });

  it("recognises popular as supported and rejects every other bankCode", () => {
    expect(isSupportedRunNowBankCode("popular")).toBe(true);
    expect(isSupportedRunNowBankCode("banreservas")).toBe(false);
    expect(isSupportedRunNowBankCode("bhd")).toBe(false);
    expect(isSupportedRunNowBankCode("")).toBe(false);
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

describe("scrapeRunStatusLabel", () => {
  it("labels throttled runs as deferred instead of requiring admin action", () => {
    expect(scrapeRunStatusLabel("throttled")).toBe("Pospuesta temporalmente");
    expect(scrapeRunStatusLabel("needs_admin_action")).toBe("Necesita acción administrativa");
  });
});
