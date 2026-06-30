import type { AuditSink } from "../audit";
import { createAuditEvent } from "../audit";
import { BANK_BROWSER_CAPACITY_ACTIONS } from "../audit/bank-actions";
import type { AdminAlertSink } from "../../worker/queues/index";
import type { BrowserCapacitySnapshot } from "../../worker/scraper/browser-runtime";

// ---------------------------------------------------------------------------
// BrowserCapacityState
//
// Host-wide gauge — the underlying BrowserSemaphore is a process-global
// singleton shared across all banks (see getSharedBrowserSemaphore in
// browser-runtime.ts), so there is intentionally no bankId dimension here.
// ---------------------------------------------------------------------------

export interface BrowserCapacityState {
  status: "normal" | "over_capacity" | "recovered";
  active: number;
  queueDepth: number;
  max: number;
  throttleEventsInWindow: number;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// BrowserCapacityMonitorDeps
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScheduleHandle = any;

export interface BrowserCapacityMonitorDeps {
  sample: () => BrowserCapacitySnapshot;
  alertSink?: Pick<AdminAlertSink, "notifyCapacityAttention">;
  auditSink?: Pick<AuditSink, "record">;
  intervalMs: number;
  /** Sustain window before an over-threshold condition alerts. Default 5 min. */
  sustainedThresholdMs?: number;
  /** queueDepth > max * multiplier triggers the over-threshold condition. Default 2. */
  queueDepthMultiplier?: number;
  clock?: () => Date;
  /** Injectable scheduler; defaults to setInterval/clearInterval. */
  schedule?: (fn: () => void, ms: number) => ScheduleHandle;
  clearSchedule?: (handle: ScheduleHandle) => void;
}

export interface BrowserCapacityMonitor {
  tick(): Promise<BrowserCapacityState>;
  start(): void;
  stop(): void;
  lastState(): BrowserCapacityState | null;
}

const DEFAULT_SUSTAINED_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_QUEUE_DEPTH_MULTIPLIER = 2;
const AUDIT_ACTOR = "system:browser-capacity-monitor";

/**
 * Polls the host-wide BrowserSemaphore capacity and alerts/audits on
 * sustained over-capacity, mirroring createBankSessionMonitor's shape and
 * transition discipline (alert+audit only on transition, sink failures never
 * break tick()).
 *
 * Transition rules:
 *   - queueDepth > max * queueDepthMultiplier sustained >= sustainedThresholdMs
 *     → alert + audit "over_capacity" exactly once per episode (alertedForCurrentEpisode guard)
 *   - queueDepth drops back to/under threshold after an alerted episode
 *     → alert + audit "recovered" exactly once, firing immediately (no sustain required)
 *   - dropping under threshold before reaching sustain resets the timer with no alert
 *   - max <= 0 never produces a false over-capacity (guarded explicitly)
 */
export function createBrowserCapacityMonitor(
  deps: BrowserCapacityMonitorDeps,
): BrowserCapacityMonitor {
  const {
    sample,
    alertSink,
    auditSink,
    intervalMs,
    sustainedThresholdMs = DEFAULT_SUSTAINED_THRESHOLD_MS,
    queueDepthMultiplier = DEFAULT_QUEUE_DEPTH_MULTIPLIER,
    clock = () => new Date(),
    schedule = setInterval,
    clearSchedule = clearInterval,
  } = deps;

  let previousState: BrowserCapacityState | null = null;
  let previousThrottleCount = 0;
  let overThresholdSinceMs: number | null = null;
  let alertedForCurrentEpisode = false;
  let handle: ScheduleHandle | null = null;

  async function tick(): Promise<BrowserCapacityState> {
    const snap = sample();
    const now = clock().getTime();
    const checkedAt = new Date(now).toISOString();

    const throttleEventsInWindow = Math.max(0, snap.throttleCount - previousThrottleCount);
    previousThrottleCount = snap.throttleCount;

    const isOverThreshold = snap.max > 0 && snap.queueDepth > snap.max * queueDepthMultiplier;
    overThresholdSinceMs = isOverThreshold ? (overThresholdSinceMs ?? now) : null;
    const sustained = isOverThreshold && now - (overThresholdSinceMs as number) >= sustainedThresholdMs;

    let status: BrowserCapacityState["status"] = sustained ? "over_capacity" : "normal";
    let transitionAction: string | null = null;

    if (sustained && !alertedForCurrentEpisode) {
      alertedForCurrentEpisode = true;
      transitionAction = BANK_BROWSER_CAPACITY_ACTIONS.WARNING;
    } else if (!isOverThreshold && alertedForCurrentEpisode) {
      status = "recovered";
      alertedForCurrentEpisode = false;
      transitionAction = BANK_BROWSER_CAPACITY_ACTIONS.RECOVERED;
    }

    const state: BrowserCapacityState = {
      status,
      active: snap.active,
      queueDepth: snap.queueDepth,
      max: snap.max,
      throttleEventsInWindow,
      checkedAt,
    };
    previousState = state;

    if (transitionAction) {
      const eventStatus = status === "recovered" ? "recovered" : "over_capacity";
      await emitAlert(alertSink, { ...state, status: eventStatus });
      await emitAudit(auditSink, transitionAction, state);
    }

    return state;
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

    lastState() {
      return previousState;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function emitAlert(
  alertSink: Pick<AdminAlertSink, "notifyCapacityAttention"> | undefined,
  event: { status: "over_capacity" | "recovered" } & Omit<BrowserCapacityState, "status">,
): Promise<void> {
  if (!alertSink?.notifyCapacityAttention) return;
  try {
    await alertSink.notifyCapacityAttention(event);
  } catch {
    // Alert failures must never propagate.
  }
}

async function emitAudit(
  auditSink: Pick<AuditSink, "record"> | undefined,
  action: string,
  state: BrowserCapacityState,
): Promise<void> {
  if (!auditSink) return;
  try {
    const event = createAuditEvent({
      actorId: AUDIT_ACTOR,
      actorRole: "system",
      action,
      target: "browser_capacity",
      targetId: null,
      // Strictly numeric/status/timestamp fields — no secrets, no URLs.
      metadata: {
        active: state.active,
        queueDepth: state.queueDepth,
        max: state.max,
        throttleEventsInWindow: state.throttleEventsInWindow,
        checkedAt: state.checkedAt,
      },
    });
    await auditSink.record(event);
  } catch {
    // Audit failures must never propagate.
  }
}
