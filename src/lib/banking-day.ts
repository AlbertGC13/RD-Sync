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
