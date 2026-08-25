import { describe, expect, it } from "vitest";

import { createBhdPersonalReadonlySessionChecker, type BhdPersonalSessionPageObservation } from "./bhd-personal-session-checker";

function page(url: string, authenticatedMarker = false, loginEvidence = false): BhdPersonalSessionPageObservation {
  return {
    async currentUrl() { return url; },
    async hasAuthenticatedMarker() { return authenticatedMarker; },
    async hasLoginPageEvidence() { return loginEvidence; },
  };
}

describe("BHD Personal read-only session checker", () => {
  const clock = () => new Date("2026-08-24T00:00:00.000Z");

  it("accepts only trusted authenticated dashboard and product-detail routes with marker evidence", async () => {
    for (const hash of ["#/bhd/dashboard", "#/bhd/product-detail"]) {
      await expect(createBhdPersonalReadonlySessionChecker({ page: page(`https://ibp.bhd.com.do/${hash}`, true), clock }).check())
        .resolves.toEqual({ status: "active", checkedAt: "2026-08-24T00:00:00.000Z", safeSummary: "BHD Personal session is active." });
    }
  });

  it("reports expiration only for the exact trusted login route with login-page evidence", async () => {
    await expect(createBhdPersonalReadonlySessionChecker({ page: page("https://ibp.bhd.com.do/#/login", false, true), clock }).check())
      .resolves.toEqual({ status: "expired", checkedAt: "2026-08-24T00:00:00.000Z", safeSummary: "BHD Personal sign-in is required." });
  });

  it("fails closed for missing markers, protected routes, hostile URLs, and observation errors", async () => {
    const unavailable = { status: "browser_unavailable", checkedAt: "2026-08-24T00:00:00.000Z", safeSummary: "BHD Personal session is unavailable." };
    for (const observation of [
      page("https://ibp.bhd.com.do/#/bhd/dashboard"),
      page("https://ibp.bhd.com.do/#/security-question"),
      page("https://ibp.bhd.com.do/#/login"),
      page("https://evil.example/#/login", false, true),
      page("https://user:pass@ibp.bhd.com.do/#/login", false, true),
      { async currentUrl() { throw new Error("challenge details must not escape"); }, async hasAuthenticatedMarker() { return false; }, async hasLoginPageEvidence() { return false; } },
    ]) await expect(createBhdPersonalReadonlySessionChecker({ page: observation, clock }).check()).resolves.toEqual(unavailable);
  });
});
