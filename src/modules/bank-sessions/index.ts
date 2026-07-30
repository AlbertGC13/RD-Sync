import type { AuditSink } from "../audit";
import { createAuditEvent } from "../audit";
import { BANK_SESSION_ACTIONS } from "../audit/bank-actions";
import { randomUUID } from "node:crypto";

import type { AdminAlertSink } from "../../worker/queues/index";
import type {
  BankSessionExpiryEpisode,
  BankSessionExpiryEpisodeRepository,
  CreateBankSessionExpiryEpisodeInput,
} from "./expiry-episodes";
import { deliverExpiryEpisodeAudit, restoreExpiryEpisode } from "./expiry-episodes";
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

interface BankSessionMonitorBaseDeps {
  check: () => Promise<BankSessionCheckResult>;
  alertSink: Pick<AdminAlertSink, "notifySessionAttention">;
  auditSink?: Pick<AuditSink, "record">;
  intervalMs: number;
  clock?: () => Date;
  /** Injectable scheduler; defaults to setInterval/clearInterval. */
  schedule?: (fn: () => void, ms: number) => ScheduleHandle;
  clearSchedule?: (handle: ScheduleHandle) => void;
}

export type BankSessionMonitorMode =
  | { mode: "alert_only" }
  | {
    mode: "expiry_events";
    bankCode: string;
    episodes: BankSessionExpiryEpisodeRepository;
    createExpiredEventId?: () => string;
    publish?(episode: BankSessionExpiryEpisode): Promise<void>;
  };

/** Valid monitor modes prevent partially-wired durable producers. */
export interface BankSessionMonitorDeps extends BankSessionMonitorBaseDeps {
  /** Omitted mode preserves the established alert-only monitor contract. */
  monitorMode?: BankSessionMonitorMode;
}

export interface BankSessionMonitor {
  tick(): Promise<BankSessionCheckResult>;
  start(): void;
  stop(): void;
  lastResult(): BankSessionCheckResult | null;
}

/**
 * Derive the stable durable identity for one expiry episode.
 */
export function createExpiredSessionRunId(bankCode: string, expiredEventId: string): string {
  return `${bankCode}-expiry-${expiredEventId}`;
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
    monitorMode = { mode: "alert_only" },
  } = deps;
  const expiryEpisodes = monitorMode.mode === "expiry_events" ? monitorMode.episodes : undefined;
  const expiryBankCode = monitorMode.mode === "expiry_events" ? monitorMode.bankCode : undefined;
  const createEpisodeId = monitorMode.mode === "expiry_events"
    ? (monitorMode.createExpiredEventId ?? randomUUID)
    : null;
  const publishEpisode = monitorMode.mode === "expiry_events" ? monitorMode.publish : undefined;

  let previousTransition: BankSessionCheckResult | null = null;
  let lastObservedResult: BankSessionCheckResult | null = null;
  let tickInFlight: Promise<BankSessionCheckResult> | null = null;
  let recoveryEpisode: BankSessionExpiryEpisode | null = null;
  let pendingExpiryCandidate: {
    input: CreateBankSessionExpiryEpisodeInput;
    observedResult: BankSessionCheckResult;
  } | null = null;
  let handle: ScheduleHandle | null = null;

  async function tickOnce(): Promise<BankSessionCheckResult> {
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

    lastObservedResult = result;
    const prevStatus = previousTransition?.status ?? null;
    const nextStatus = result.status;

    // Determine if this is a transition that warrants alerting/auditing.
    // isNewBad fires only when coming FROM a non-bad (null or active) state,
    // so flapping between two bad states (e.g. expired ↔ browser_unavailable)
    // does not produce repeated alerts.
    const wasBad = prevStatus !== null && prevStatus !== "active";
    const isNewBad = nextStatus !== "active" && !wasBad;
    const isRecovery =
      nextStatus === "active" && prevStatus !== null && prevStatus !== "active";
    let createdEpisode = false;
    let expiryAuditAcknowledged = false;
    let expiryNotificationResult: BankSessionCheckResult | null = null;
    let transitionReady = true;
    if (nextStatus === "active") pendingExpiryCandidate = null;

    if (nextStatus !== "active" && (nextStatus === "expired" || pendingExpiryCandidate) && expiryEpisodes && expiryBankCode && createEpisodeId) {
      const candidate = pendingExpiryCandidate ?? {
        input: (() => {
          const expiredEventId = createEpisodeId();
          return {
            bankCode: expiryBankCode,
            expiredEventId,
            runId: createExpiredSessionRunId(expiryBankCode, expiredEventId),
          };
        })(),
        observedResult: result,
      };
      pendingExpiryCandidate = candidate;
      try {
        const episodeResult = await expiryEpisodes.getOrCreate(candidate.input);
        const durableEpisode = episodeResult.episode;
        createdEpisode = episodeResult.created;
        recoveryEpisode = durableEpisode;
        expiryAuditAcknowledged = await deliverExpiryEpisodeAudit(auditSink, expiryEpisodes, durableEpisode, "expired", result.checkedAt);
        transitionReady = expiryAuditAcknowledged;
        if (createdEpisode) {
          expiryNotificationResult = candidate.observedResult;
        }
        if (expiryAuditAcknowledged && (durableEpisode.publicationState === "pending" || durableEpisode.publicationState === "publishing" || durableEpisode.publicationState === "published")) await publishEpisode?.(durableEpisode);
        pendingExpiryCandidate = null;
      } catch {
        // A durable election outage must not fall back to process-local side effects.
        transitionReady = false;
      }
    }

    if (nextStatus === "active" && expiryEpisodes && expiryBankCode && !recoveryEpisode) {
      try {
        recoveryEpisode = await expiryEpisodes.findByBankCode(expiryBankCode);
      } catch {
        // The next active tick safely retries the durable lookup without advancing state.
        transitionReady = false;
      }
    }

    let recoveryClosed = nextStatus !== "active" || !recoveryEpisode;
    let recoveryWon = false;
    if (nextStatus === "active" && expiryEpisodes && recoveryEpisode) {
      const observedEpisode = recoveryEpisode;
      const restoration = await restoreExpiryEpisode(
        auditSink,
        expiryEpisodes,
        observedEpisode,
        result.checkedAt,
      );
      recoveryWon = restoration === "closed";
      recoveryClosed = restoration !== "retained";
      if (recoveryClosed) recoveryEpisode = null;
    }

    const usesDurableExpiryEpisodes = expiryEpisodes !== undefined && expiryBankCode !== undefined;
    if (expiryNotificationResult) {
      await emitAlert(alertSink, expiryNotificationResult);
    }
    if (
      (!usesDurableExpiryEpisodes && isNewBad) ||
      (nextStatus !== "expired" && isNewBad) ||
      (isRecovery && !usesDurableExpiryEpisodes) ||
      recoveryWon
    ) {
      await emitAlert(alertSink, result);
    }

    if (
      (!usesDurableExpiryEpisodes || nextStatus === "browser_unavailable") &&
      (isNewBad || isRecovery)
    ) {
      await emitAudit(auditSink, result);
    }

    // mutation_started/manual_recovery_required retain; resolved closes and emits the normal active alert.
    if (transitionReady && (recoveryClosed || nextStatus !== "active")) {
      previousTransition = result;
    }
    return result;
  }

  async function tick(): Promise<BankSessionCheckResult> {
    if (tickInFlight) return tickInFlight;
    const current = tickOnce();
    tickInFlight = current;
    void current.finally(() => {
      if (tickInFlight === current) tickInFlight = null;
    });
    return current;
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
      return lastObservedResult;
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
        ? BANK_SESSION_ACTIONS.RESTORED
        : result.status === "expired"
          ? BANK_SESSION_ACTIONS.EXPIRED
          : BANK_SESSION_ACTIONS.UNAVAILABLE;

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
