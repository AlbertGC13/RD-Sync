import { describe, expect, it } from "vitest";

import { getSantoDomingoDayKey } from "./banking-day";

describe("getSantoDomingoDayKey", () => {
  it("groups a postedAt at noon UTC to the same calendar day in Santo Domingo", () => {
    // 12:00 UTC → 08:00 Santo Domingo (UTC-4 year-round — no DST in DR).
    expect(getSantoDomingoDayKey("2026-06-07T12:00:00.000Z")).toBe("2026-06-07");
  });

  it("shifts a transaction posted at 03:30Z to the PREVIOUS Santo Domingo day", () => {
    // 03:30 UTC → 23:30 the previous day in Santo Domingo.
    // This is the exact regression case the previous UTC-based grouping got wrong.
    expect(getSantoDomingoDayKey("2026-06-07T03:30:00.000Z")).toBe("2026-06-06");
  });

  it("keeps a transaction posted at 05:30Z on the same Santo Domingo day as the UTC day", () => {
    // 05:30 UTC → 01:30 Santo Domingo same UTC date — bucket must stay on 06-07.
    expect(getSantoDomingoDayKey("2026-06-07T05:30:00.000Z")).toBe("2026-06-07");
  });

  it("produces a deterministic YYYY-MM-DD string for Date inputs", () => {
    const date = new Date("2026-06-07T03:30:00.000Z");
    expect(getSantoDomingoDayKey(date)).toBe("2026-06-06");
    expect(getSantoDomingoDayKey(date)).toBe(getSantoDomingoDayKey("2026-06-07T03:30:00.000Z"));
  });

  it("throws on an invalid date string so callers can fail-fast", () => {
    expect(() => getSantoDomingoDayKey("not-a-date")).toThrowError(/Invalid date/);
  });
});
