import type { ReadonlySessionChecker } from "./authenticated-session-probe";

const BHD_PERSONAL_ORIGIN = "https://ibp.bhd.com.do";
const BHD_PERSONAL_LOGIN_HASH = "#/login";
const AUTHENTICATED_HASHES = new Set(["#/bhd/dashboard", "#/bhd/product-detail"]);
const SAFE_SUMMARY_UNAVAILABLE = "BHD Personal session is unavailable.";

/**
 * Read-only BHD page seam. Implementations expose only route and boolean
 * evidence, so page content and protected-flow details cannot escape.
 */
export interface BhdPersonalSessionPageObservation {
  currentUrl(): Promise<string>;
  hasAuthenticatedMarker(): Promise<boolean>;
  hasLoginPageEvidence(): Promise<boolean>;
}

export type BhdPersonalSessionCheckerDependencies = Readonly<{
  page: BhdPersonalSessionPageObservation;
  clock?: () => Date;
}>;

type CheckResult = Readonly<{
  status: "active" | "expired" | "browser_unavailable";
  checkedAt: string;
  safeSummary: string;
}>;

function unavailable(clock: () => Date): CheckResult {
  return { status: "browser_unavailable", checkedAt: clock().toISOString(), safeSummary: SAFE_SUMMARY_UNAVAILABLE };
}

function trustedHash(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === BHD_PERSONAL_ORIGIN && !url.username && !url.password
      ? url.hash
      : undefined;
  } catch {
    return undefined;
  }
}

/** Classifies only proven BHD session states; all other observations fail closed. */
export function createBhdPersonalReadonlySessionChecker(
  { page, clock = () => new Date() }: BhdPersonalSessionCheckerDependencies,
): ReadonlySessionChecker {
  return Object.freeze({
    async check(): Promise<CheckResult> {
      try {
        const hash = trustedHash(await page.currentUrl());
        if (hash === undefined) return unavailable(clock);
        if (AUTHENTICATED_HASHES.has(hash)) {
          return await page.hasAuthenticatedMarker()
            ? { status: "active", checkedAt: clock().toISOString(), safeSummary: "BHD Personal session is active." }
            : unavailable(clock);
        }
        if (hash === BHD_PERSONAL_LOGIN_HASH && await page.hasLoginPageEvidence()) {
          return { status: "expired", checkedAt: clock().toISOString(), safeSummary: "BHD Personal sign-in is required." };
        }
        return unavailable(clock);
      } catch {
        return unavailable(clock);
      }
    },
  });
}
