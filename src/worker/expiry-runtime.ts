import { randomUUID } from "node:crypto";

import { popularScraperProfile } from "../modules/bank-adapters/popular";
import { createBankSessionMonitor, createCdpSessionChecker, type BankSessionMonitor } from "../modules/bank-sessions";
import { deliverManualRecoveryResolutionAudit, type ManualRecoveryResolutionAuditOutboxRepository } from "../modules/bank-sessions/manual-recovery-resolution-audit-delivery";
import { reconcileExpiryTerminalObservation, type ExpiryTerminalReconciliationRepository } from "../modules/bank-sessions/expiry-terminal-reconciliation";
import type { BankSessionExpiryEpisodeRepository, ExpiryPublicationPublisher } from "../modules/bank-sessions/expiry-episodes";
import type { AuditSink } from "../modules/audit";
import { PrismaAuditSink } from "../modules/persistence/prisma-audit-sink";
import { PrismaManualRecoveryResolutionAuditOutboxRepository } from "../modules/persistence/prisma-manual-recovery-resolution-audit-outbox-repository";
import { getPrismaClient } from "../modules/persistence/prisma-client";
import { resolveDefaultAlertSink } from "./alerts/email-alert-sink";
import { resolveBankBrowserEnv } from "./scraper/browser-runtime";
import type { AdminAlertSink } from "./queues";

type Timer = ReturnType<typeof setInterval> | number;
const INTERVAL_MS = 60_000;
const LEASE_MS = 30_000;
const MAX_MANUAL_RECOVERY_AUDIT_DELIVERIES_PER_TICK = 100;
const TERMINAL_ALERT = "Automatic session recovery requires administrative review";

export interface ExpiryRuntime {
  readonly enabled: boolean;
  tick(): Promise<void>;
  start(): void;
  shutdown(): Promise<void>;
}

export interface ExpiryRuntimeDependencies {
  monitor: Pick<BankSessionMonitor, "tick">;
  legacyPublicationObservation?: {
    episodes: Pick<BankSessionExpiryEpisodeRepository, "findByBankCode"> & ExpiryTerminalReconciliationRepository;
    publisher: Pick<ExpiryPublicationPublisher, "observe">;
  };
  outbox: ManualRecoveryResolutionAuditOutboxRepository;
  auditSink: AuditSink;
  alerts: Pick<AdminAlertSink, "notifySessionAttention">;
  bankCode: string;
  leaseOwner: string;
  close?(): Promise<void>;
  schedule?(callback: () => void, intervalMs: number): Timer;
  clearSchedule?(timer: Timer): void;
  clock?(): Date;
}

export function createExpiryRuntime(
  env: Record<string, string | undefined>,
  create: () => ExpiryRuntimeDependencies,
): ExpiryRuntime {
  if (env.RD_SYNC_SESSION_MONITOR !== "enabled") return disabledRuntime;
  if (!env.DATABASE_URL) {
    throw new Error("Expiry runtime requires DATABASE_URL");
  }
  return createEnabledRuntime(create());
}

const disabledRuntime: ExpiryRuntime = {
  enabled: false,
  async tick() {},
  start() {},
  async shutdown() {},
};

function createEnabledRuntime(deps: ExpiryRuntimeDependencies): ExpiryRuntime {
  const schedule = deps.schedule ?? setInterval;
  const clearSchedule = deps.clearSchedule ?? clearInterval;
  const clock = deps.clock ?? (() => new Date());
  let timer: Timer | undefined;
  let inFlight: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;

  async function observeTerminalEpisode(): Promise<void> {
    const legacy = deps.legacyPublicationObservation;
    if (!legacy) return;
    const episode = await legacy.episodes.findByBankCode(deps.bankCode);
    if (!episode || episode.publicationState !== "published" || !episode.publicationClaimToken) return;
    const envelope = {
      bankCode: episode.bankCode,
      expiredEventId: episode.expiredEventId,
      runId: episode.runId,
      token: episode.publicationClaimToken,
    };
    const observation = await reconcileExpiryTerminalObservation(
      () => legacy.publisher.observe(envelope),
      legacy.episodes,
      envelope,
      clock,
    );
    if (observation.kind === "terminal" && observation.result.status === "reconciled") {
      await deps.alerts.notifySessionAttention({
        status: "expired",
        safeSummary: TERMINAL_ALERT,
        checkedAt: clock().toISOString(),
      });
    }
  }

  async function tickOnce(): Promise<void> {
    await deps.monitor.tick();
    await observeTerminalEpisode();
    for (let delivered = true, deliveries = 0; delivered && deliveries < MAX_MANUAL_RECOVERY_AUDIT_DELIVERIES_PER_TICK; deliveries += 1) {
      delivered = await deliverManualRecoveryResolutionAudit(
        deps.outbox,
        deps.auditSink,
        deps.leaseOwner,
        LEASE_MS,
      );
    }
  }

  const runtime: ExpiryRuntime = {
    enabled: true,
    tick() {
      if (!inFlight) inFlight = tickOnce().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    start() {
      if (!timer) timer = schedule(() => { void runtime.tick().catch(() => undefined); }, INTERVAL_MS);
    },
    shutdown() {
      if (!shutdown) shutdown = (async () => {
        if (timer) clearSchedule(timer);
        timer = undefined;
        try {
          await inFlight;
        } catch {
          // tick() retains its failure; shutdown only waits for the resource-safe boundary.
        } finally {
          await deps.close?.();
        }
      })();
      return shutdown;
    },
  };
  return runtime;
}

export function createDefaultExpiryRuntime(
  env: Record<string, string | undefined> = process.env,
): ExpiryRuntime {
  return createExpiryRuntime(env, () => {
    const prisma = getPrismaClient();
    const alerts = resolveDefaultAlertSink();
    const auditSink = new PrismaAuditSink();
    const bankCode = popularScraperProfile.bankId;
    return {
      bankCode,
      outbox: new PrismaManualRecoveryResolutionAuditOutboxRepository(prisma),
      auditSink,
      alerts,
      leaseOwner: `expiry-runtime:${randomUUID()}`,
      monitor: createBankSessionMonitor({
        check: createCdpSessionChecker({
          cdpUrl: resolveBankBrowserEnv(bankCode, env).cdpUrl,
        }).check,
        alertSink: alerts,
        auditSink,
        intervalMs: INTERVAL_MS,
        monitorMode: { mode: "alert_only" },
      }),
    };
  });
}
