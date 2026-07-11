import type { AuditSink } from "../audit";
import { createAuditEvent } from "../audit";
import type { AdminAlertSink } from "../../worker/queues/index";
import {
  CdpPopularPortalPage,
  type CdpBrowserLike,
  type CdpPageLike,
} from "../../worker/scraper/navigation/popular-cdp";
import {
  assertCdpLoopback,
  connectPlaywrightOverCdp,
  DEFAULT_CDP_URL,
  openCdpPageInDefaultContext,
} from "../../worker/scraper/browser-runtime";

// ---------------------------------------------------------------------------
// Re-export the structural types the CDP adapter already declares so callers
// can import everything from one place.
// ---------------------------------------------------------------------------

export type { CdpBrowserLike, CdpPageLike };

// ---------------------------------------------------------------------------
// BankSessionStatus
// ---------------------------------------------------------------------------

export type BankSessionStatus = "active" | "expired" | "browser_unavailable";

// ---------------------------------------------------------------------------
// BankSessionCheckResult
// ---------------------------------------------------------------------------

export interface BankSessionCheckResult {
  status: BankSessionStatus;
  /** ISO 8601 timestamp of when the check was performed. */
  checkedAt: string;
  /**
   * Fixed human-readable summary. Only one of these three strings is ever
   * returned — no URL, account, or error interpolation.
   */
  safeSummary: string;
}

const SUMMARY_ACTIVE = "Bank session is active";
const SUMMARY_EXPIRED = "Bank session expired or requires verification";
const SUMMARY_UNAVAILABLE = "Bank browser session is not available";

// ---------------------------------------------------------------------------
// SessionProbePage — narrow structural interface for health checks
//
// Intentionally narrower than PopularPortalPage: no readResultsTable,
// openDashboardAccount, or pause. The health probe is read-only and
// interaction-free.
// ---------------------------------------------------------------------------

export interface SessionProbePage {
  goto(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  waitForVisibleText(text: string, timeoutMs: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// checkPopularSessionHealth — pure probe logic
// ---------------------------------------------------------------------------

export interface CheckPopularSessionHealthOptions {
  baseUrl?: string;
  waitTimeoutMs?: number;
  clock?: () => Date;
}

/**
 * Probes the Popular portal dashboard to determine whether the bank session
 * is active or expired.
 *
 * Steps:
 *   1. goto {baseUrl}/dashboard
 *   2. currentUrl() does not include "/dashboard" → expired
 *   3. waitForVisibleText("Producto") returns false → expired
 *   4. Otherwise → active
 *
 * browser_unavailable is decided by the CDP wrapper (createCdpSessionChecker),
 * never by this function.
 */
export async function checkPopularSessionHealth(
  page: SessionProbePage,
  options: CheckPopularSessionHealthOptions = {},
): Promise<BankSessionCheckResult> {
  const {
    baseUrl = "https://ib.bpd.com.do",
    waitTimeoutMs = 15_000,
    clock = () => new Date(),
  } = options;

  const checkedAt = clock().toISOString();

  await page.goto(`${baseUrl}/dashboard`);

  const url = await page.currentUrl();
  if (!url.includes("/dashboard")) {
    return { status: "expired", checkedAt, safeSummary: SUMMARY_EXPIRED };
  }

  const visible = await page.waitForVisibleText("Producto", waitTimeoutMs);
  if (!visible) {
    return { status: "expired", checkedAt, safeSummary: SUMMARY_EXPIRED };
  }

  return { status: "active", checkedAt, safeSummary: SUMMARY_ACTIVE };
}

// ---------------------------------------------------------------------------
// createCdpSessionChecker — CDP-attached checker factory
//
// Mirrors createPopularCdpScraper EXACTLY for connect/page lifecycle.
// ---------------------------------------------------------------------------

export interface CdpSessionCheckerOptions {
  cdpUrl?: string;
  baseUrl?: string;
  waitTimeoutMs?: number;
  connect?: (cdpUrl: string) => Promise<CdpBrowserLike>;
  clock?: () => Date;
}

export interface CdpSessionChecker {
  check(): Promise<BankSessionCheckResult>;
}

/**
 * Creates a session checker that attaches to an existing human-opened Brave
 * browser session via CDP and probes the Popular portal dashboard.
 *
 * Connect failures → browser_unavailable (never throws).
 * Always closes the created page and then the browser handle in finally.
 */
export function createCdpSessionChecker(
  options: CdpSessionCheckerOptions = {},
): CdpSessionChecker {
  const {
    cdpUrl = DEFAULT_CDP_URL,
    baseUrl = "https://ib.bpd.com.do",
    waitTimeoutMs = 15_000,
    connect = connectPlaywrightOverCdp<CdpBrowserLike>,
    clock = () => new Date(),
  } = options;

  return {
    async check(): Promise<BankSessionCheckResult> {
      let browser: CdpBrowserLike | null = null;
      let cdpPage: CdpPageLike | null = null;

      try {
        try {
          assertCdpLoopback(cdpUrl);
        } catch {
          return {
            status: "browser_unavailable",
            checkedAt: clock().toISOString(),
            safeSummary: SUMMARY_UNAVAILABLE,
          };
        }

        try {
          browser = await connect(cdpUrl);
        } catch {
          return {
            status: "browser_unavailable",
            checkedAt: clock().toISOString(),
            safeSummary: SUMMARY_UNAVAILABLE,
          };
        }

        cdpPage = await openCdpPageInDefaultContext(browser);

        const probePage = new CdpPopularPortalPage(cdpPage);
        return await checkPopularSessionHealth(probePage, { baseUrl, waitTimeoutMs, clock });
      } finally {
        if (cdpPage !== null) {
          try {
            await cdpPage.close();
          } catch {
            // Ignore page close errors
          }
        }
        if (browser !== null) {
          try {
            await browser.close();
          } catch {
            // Ignore browser handle close errors
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// BankSessionMonitorDeps — dependencies for the monitor
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScheduleHandle = any;

export interface BankSessionMonitorDeps {
  check: () => Promise<BankSessionCheckResult>;
  alertSink: Pick<AdminAlertSink, "notifySessionAttention">;
  auditSink?: Pick<AuditSink, "record">;
  intervalMs: number;
  clock?: () => Date;
  /** Injectable scheduler; defaults to setInterval/clearInterval. */
  schedule?: (fn: () => void, ms: number) => ScheduleHandle;
  clearSchedule?: (handle: ScheduleHandle) => void;
}

export interface BankSessionMonitor {
  tick(): Promise<BankSessionCheckResult>;
  start(): void;
  stop(): void;
  lastResult(): BankSessionCheckResult | null;
}

// ---------------------------------------------------------------------------
// createBankSessionMonitor
// ---------------------------------------------------------------------------

const AUDIT_ACTOR = "system:session-monitor";

/**
 * Wraps a session checker with transition-based alerting and auditing.
 *
 * Alert / audit transition rules:
 *   - null → expired       → alert + audit bank_session.expired
 *   - null → unavailable   → alert + audit bank_session.unavailable
 *   - active → expired     → alert + audit bank_session.expired
 *   - active → unavailable → alert + audit bank_session.unavailable
 *   - expired → active     → alert + audit bank_session.restored
 *   - unavailable → active → alert + audit bank_session.restored
 *   - repeated bad state   → silent (no re-alert)
 *   - bad → different bad  → silent (e.g. expired → browser_unavailable does not re-alert)
 *   - repeated active      → silent
 *
 * Audit / alert failures never break tick().
 */
export function createBankSessionMonitor(
  deps: BankSessionMonitorDeps,
): BankSessionMonitor {
  const {
    check,
    alertSink,
    auditSink,
    intervalMs,
    clock = () => new Date(),
    schedule = setInterval,
    clearSchedule = clearInterval,
  } = deps;

  let previous: BankSessionCheckResult | null = null;
  let handle: ScheduleHandle | null = null;

  async function tick(): Promise<BankSessionCheckResult> {
    let result: BankSessionCheckResult;
    try {
      result = await check();
    } catch {
      // If check itself throws (unexpected), treat as unavailable.
      result = {
        status: "browser_unavailable",
        checkedAt: clock().toISOString(),
        safeSummary: SUMMARY_UNAVAILABLE,
      };
    }

    const prevStatus = previous?.status ?? null;
    const nextStatus = result.status;

    previous = result;

    // Determine if this is a transition that warrants alerting/auditing.
    // isNewBad fires only when coming FROM a non-bad (null or active) state,
    // so flapping between two bad states (e.g. expired ↔ browser_unavailable)
    // does not produce repeated alerts.
    const wasBad = prevStatus !== null && prevStatus !== "active";
    const isNewBad = nextStatus !== "active" && !wasBad;
    const isRecovery =
      nextStatus === "active" && prevStatus !== null && prevStatus !== "active";

    if (isNewBad || isRecovery) {
      await emitAlert(alertSink, result);
      await emitAudit(auditSink, result);
    }

    return result;
  }

  return {
    tick,

    start() {
      if (handle !== null) return; // idempotent
      handle = schedule(() => {
        void tick().catch(() => undefined);
      }, intervalMs);
    },

    stop() {
      if (handle === null) return;
      clearSchedule(handle);
      handle = null;
    },

    lastResult() {
      return previous;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function emitAlert(
  alertSink: Pick<AdminAlertSink, "notifySessionAttention">,
  result: BankSessionCheckResult,
): Promise<void> {
  try {
    await alertSink.notifySessionAttention({
      status: result.status,
      safeSummary: result.safeSummary,
      checkedAt: result.checkedAt,
    });
  } catch {
    // Alert failures must never propagate.
  }
}

async function emitAudit(
  auditSink: Pick<AuditSink, "record"> | undefined,
  result: BankSessionCheckResult,
): Promise<void> {
  if (!auditSink) return;
  try {
    const action =
      result.status === "active"
        ? "bank_session.restored"
        : result.status === "expired"
          ? "bank_session.expired"
          : "bank_session.unavailable";

    const event = createAuditEvent({
      actorId: AUDIT_ACTOR,
      actorRole: "system",
      action,
      target: "bank_session",
      targetId: null,
      metadata: { checkedAt: result.checkedAt },
    });
    await auditSink.record(event);
  } catch {
    // Audit failures must never propagate.
  }
}
