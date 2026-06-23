/**
 * Banking-day grouping helper.
 *
 * Transactions carry an absolute `postedAt` instant (UTC ISO 8601 string or
 * Date). When grouping them under a "day header" for the dashboard we must
 * group by the **Santo Domingo banking day** — operators read the dashboard
 * in America/Santo_Domingo and a postedAt at 03:30Z on a given date is the
 * *previous* local day for them.
 *
 * Using `Date#toISOString().slice(0, 10)` would group by UTC day and shift
 * late-evening transactions into the wrong bucket. This helper produces a
 * deterministic `YYYY-MM-DD` key in the Santo Domingo timezone using Intl.
 */

const SANTO_DOMINGO_TIMEZONE = "America/Santo_Domingo";
const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: SANTO_DOMINGO_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getSantoDomingoDayKey(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for Santo Domingo day key: ${String(input)}`);
  }
  // en-CA produces YYYY-MM-DD in the target timezone — deterministic across
  // Node.js versions and ICU builds.
  return DAY_KEY_FORMATTER.format(date);
}

export const BANKING_TIMEZONE = SANTO_DOMINGO_TIMEZONE;

/**
 * Returns the UTC instants bounding a Santo Domingo local day, so date
 * filters sent as `YYYY-MM-DD` are interpreted by the local day boundary
 * (not by UTC midnight, which would shift late-evening DR transactions into
 * the wrong filter bucket).
 *
 * `start` is 00:00:00.000 America/Santo_Domingo and `end` is
 * 23:59:59.999 America/Santo_Domingo — both expressed as UTC Date objects so
 * they can be compared directly against stored UTC instants.
 *
 * DR observes no DST (UTC-4 year-round), so the offset is a fixed -4 hours.
 * A pure `YYYY-MM-DD` string is treated as a calendar date in Santo Domingo
 * (NOT parsed as UTC midnight, which is the bug this helper fixes); a full
 * ISO string or Date is bucketed into its Santo Domingo day first.
 */
export function santoDomingoDayRange(input: string | Date): { start: Date; end: Date } {
  let dayKey: string;
  if (input instanceof Date) {
    dayKey = getSantoDomingoDayKey(input);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // Pure calendar date — treat it as a Santo Domingo local day directly.
    dayKey = input;
  } else {
    dayKey = getSantoDomingoDayKey(new Date(input));
  }

  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid Santo Domingo day key: ${dayKey}`);
  }

  // 00:00:00 local (UTC-4) = 04:00:00Z. DR has no DST so this offset is stable.
  const start = new Date(Date.UTC(year, month - 1, day, 4, 0, 0, 0));
  // 23:59:59.999 local = start + 24h - 1ms.
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}
