import { defaultAuditSink } from "../audit/defaults";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { getBrowserCapacitySnapshotFromEnv } from "../../../worker/scraper/browser-runtime";
import { createBrowserCapacityMonitor, type BrowserCapacityMonitor } from "../../../modules/observability/browser-capacity-monitor";

const globalRegistry = globalThis as typeof globalThis & { __rdSyncBrowserCapacityMonitor?: BrowserCapacityMonitor | null };

export function resolveDefaultBrowserCapacityMonitor(): BrowserCapacityMonitor | null {
  if (process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR !== "enabled") return null;
  const raw = process.env.RD_SYNC_BROWSER_CAPACITY_CHECK_INTERVAL_MS;
  const parsed = raw === undefined ? 60_000 : Number(raw);
  return createBrowserCapacityMonitor({ sample: getBrowserCapacitySnapshotFromEnv, alertSink: resolveDefaultAlertSink(), auditSink: defaultAuditSink, intervalMs: Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, 30_000) : 60_000 });
}

export function startDefaultBrowserCapacityMonitor(): BrowserCapacityMonitor | null {
  globalRegistry.__rdSyncBrowserCapacityMonitor ??= resolveDefaultBrowserCapacityMonitor();
  globalRegistry.__rdSyncBrowserCapacityMonitor?.start();
  return globalRegistry.__rdSyncBrowserCapacityMonitor;
}

export const defaultBrowserCapacityMonitor = startDefaultBrowserCapacityMonitor();
