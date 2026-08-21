import { defaultAuditSink } from "../audit/defaults";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { getBrowserCapacitySnapshotFromEnv } from "../../../worker/scraper/browser-runtime";
import { createBrowserCapacityMonitor, type BrowserCapacityMonitor } from "../../../modules/observability/browser-capacity-monitor";
const CAPACITY_MIN_INTERVAL_MS = 30_000;
const CAPACITY_DEFAULT_INTERVAL_MS = 60_000;

function resolveCapacityIntervalMs(): number { const raw = process.env.RD_SYNC_BROWSER_CAPACITY_CHECK_INTERVAL_MS; const parsed = Number(raw); return raw && Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, CAPACITY_MIN_INTERVAL_MS) : CAPACITY_DEFAULT_INTERVAL_MS; }

export function resolveDefaultBrowserCapacityMonitor(): BrowserCapacityMonitor | null {
  if (process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR !== "enabled") return null;
  return createBrowserCapacityMonitor({ sample: getBrowserCapacitySnapshotFromEnv, alertSink: resolveDefaultAlertSink(), auditSink: defaultAuditSink, intervalMs: resolveCapacityIntervalMs() });
}

const capacityGlobalRegistry = globalThis as typeof globalThis & {
  __rdSyncBrowserCapacityMonitor?: BrowserCapacityMonitor | null;
};

if (!("__rdSyncBrowserCapacityMonitor" in capacityGlobalRegistry)) capacityGlobalRegistry.__rdSyncBrowserCapacityMonitor = resolveDefaultBrowserCapacityMonitor();

export const defaultBrowserCapacityMonitor: BrowserCapacityMonitor | null = capacityGlobalRegistry.__rdSyncBrowserCapacityMonitor ?? null;

defaultBrowserCapacityMonitor?.start();
