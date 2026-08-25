import { describe, expect, it } from "vitest";

import {
  bankPortalIdentities,
  getBankPortalIdentity,
  listBankPortalIdentities,
} from "./bank-identities";

describe("bank portal identities", () => {
  it("defines unique canonical portal codes grouped under their display brands", () => {
    expect(bankPortalIdentities.map((identity) => identity.bankCode)).toEqual([
      "popular",
      "bhd_personal",
      "bhd_empresarial",
      "banreservas_personas",
      "banreservas_empresas",
    ]);
    expect(new Set(bankPortalIdentities.map((identity) => identity.bankCode)).size).toBe(bankPortalIdentities.length);
    expect(bankPortalIdentities.filter((identity) => identity.brandCode === "bhd").map((identity) => identity.bankCode)).toEqual([
      "bhd_personal",
      "bhd_empresarial",
    ]);
  });

  it("is immutable and preserves unavailable portals as metadata only", () => {
    expect(Object.isFrozen(bankPortalIdentities)).toBe(true);
    expect(bankPortalIdentities.every(Object.isFrozen)).toBe(true);
    expect(getBankPortalIdentity("bhd_empresarial")).toMatchObject({ runtimeStatus: "deferred" });
    expect(getBankPortalIdentity("banreservas_personas")).toMatchObject({ runtimeStatus: "deferred" });
  });

  it("lists and resolves exact portal codes without routing bare brands", () => {
    expect(listBankPortalIdentities()).toBe(bankPortalIdentities);
    expect(getBankPortalIdentity("bhd_personal")).toBe(bankPortalIdentities[1]);
    expect(getBankPortalIdentity("bhd")).toBeUndefined();
    expect(getBankPortalIdentity("banreservas")).toBeUndefined();
    expect(getBankPortalIdentity("unknown")).toBeUndefined();
  });
});
