import { describe, expect, it } from "vitest";

import { getSantoDomingoDayKey, santoDomingoDayRange } from "./banking-day";

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

describe("santoDomingoDayRange", () => {
  it("bounds a pure YYYY-MM-DD string to the Santo Domingo local day (UTC-4)", () => {
    const range = santoDomingoDayRange("2026-06-07");

    // 00:00:00 local = 04:00:00Z; 23:59:59.999 local = 03:59:59.999Z next day.
    expect(range.start.toISOString()).toBe("2026-06-07T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-08T03:59:59.999Z");
  });

  it("treats the YYYY-MM-DD string as a Santo Domingo calendar date, NOT as UTC midnight", () => {
    // The regression this guards against: parsing "2026-06-07" as UTC would
    // bound the day at 2026-06-07T00:00:00Z, which is 20:00 the previous day
    // in Santo Domingo and would exclude most of June 7 in DR.
    const range = santoDomingoDayRange("2026-06-07");
    expect(range.start.toISOString()).not.toBe("2026-06-07T00:00:00.000Z");
  });

  it("includes a late-evening Santo Domingo transaction in the dateTo boundary", () => {
    // A postedAt at 2026-06-07T23:30:00Z is 19:30 in Santo Domingo on June 7.
    // The end-of-local-day bound for dateTo=2026-06-07 must include it.
    const range = santoDomingoDayRange("2026-06-07");
    const postedAt = new Date("2026-06-07T23:30:00.000Z");
    expect(postedAt.getTime()).toBeGreaterThanOrEqual(range.start.getTime());
    expect(postedAt.getTime()).toBeLessThanOrEqual(range.end.getTime());
  });

  it("buckets a full ISO string into its Santo Domingo day before bounding", () => {
    // 03:30Z on 2026-06-07 is 23:30 on 2026-06-06 in Santo Domingo, so the
    // range must bound June 6, not June 7.
    const range = santoDomingoDayRange("2026-06-07T03:30:00.000Z");
    expect(range.start.toISOString()).toBe("2026-06-06T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-07T03:59:59.999Z");
  });

  it("throws on an invalid day key", () => {
    expect(() => santoDomingoDayRange("not-a-date")).toThrowError(/Invalid date/);
  });
});
