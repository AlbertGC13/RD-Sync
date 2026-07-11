/**
 * Standalone BullMQ worker process for ingestion jobs.
 *
 * Run with:  pnpm worker   (which executes: tsx src/worker/ingestion-worker.ts)
 *
 * Requires: RD_SYNC_REDIS_URL, DATABASE_URL
 *
 * The worker:
 * - Opens an ioredis connection to Redis (fails fast with a clear message if
 *   RD_SYNC_REDIS_URL is not set).
 * - Creates a BullMQ Worker on the "bank-transaction-ingestion" queue.
 * - For each job, calls the ingestion processor with real Prisma-backed deps.
 * - RETURNS the processor result so BullMQ marks the job completed.
 * - Lets unexpected throws propagate so BullMQ applies the configured
 *   attempts / exponential-backoff retry.  Terminal outcomes
 *   (needs_admin_action / failed) are caught INSIDE the processor and
 *   returned normally — they are NOT retried.
 * - Gracefully shuts down on SIGTERM / SIGINT.
 *
 * Logged: run IDs, job status, lifecycle events.  Secrets, tokens, and PII
 * are NEVER logged.
 */

// Load .env first so DATABASE_URL / RD_SYNC_REDIS_URL / scraper + alert config
// are populated before the imports below read them at module-load time.
// tsx does not auto-load .env, so the worker process needs this explicitly.
import "dotenv/config";

import { Worker } from "bullmq";

import { buildRedisConnectionOptions } from "./queues/bullmq-queue";
import { createIngestionWorker, type WorkerConstructor } from "./ingestion-worker-factory";
import { resolveDefaultAlertSink } from "./alerts/email-alert-sink";
import { bankAdapterRegistry } from "../modules/bank-adapters/registry";
import { BankAutoLoginConfigRepository } from "../modules/bank-auto-login-config/repository";
import { defaultAutoLoginLock } from "../modules/bank-auto-login-lock/defaults";
import { BankCredentialRepository } from "../modules/bank-credentials/repository";
import { resolveCredentialKey } from "../modules/bank-credentials/key-resolver";
import { createAuditEvent } from "../modules/audit";
import { BANK_AUTOLOGIN_ACTIONS, BANK_CREDENTIAL_ACTIONS } from "../modules/audit/bank-actions";
import { getPrismaClient } from "../modules/persistence/prisma-client";
import { createAcquireBrowserSlotFromEnv, createEnsureBrowserForBank, resolveBankBrowserEnv } from "./scraper/browser-runtime";
import { createProductionScrapeTimeAutoLoginBrowserOpener, createScrapeTimeAutoLoginRunner, type BankAutoLoginStrategy } from "./scraper/auto-login";
import { resolveDefaultScraper } from "../app/api/scrape-runs/consumer-defaults";
import { defaultScrapeRunRepository } from "../app/api/scrape-runs/defaults";
import { defaultTransactionRepository } from "../app/api/transactions/defaults";
import { defaultAuditSink } from "../app/api/audit/defaults";
import { createIngestionProcessor } from "./queues";

// ---------------------------------------------------------------------------
// Fail fast if required env vars are absent
// ---------------------------------------------------------------------------

const redisUrl = process.env.RD_SYNC_REDIS_URL;
if (!redisUrl) {
  console.error(
    "[ingestion-worker] RD_SYNC_REDIS_URL is not set. " +
      "Set it to the Redis connection URL (e.g. redis://localhost:6379) " +
      "and restart the worker.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Wire up real dependencies
// ---------------------------------------------------------------------------

const connection = buildRedisConnectionOptions(redisUrl);
const prisma = getPrismaClient();

function toScrapeTimeAutoLoginStrategy(strategy: unknown, bankCode: string): BankAutoLoginStrategy {
  if (isScrapeTimeAutoLoginStrategy(strategy)) return strategy;
  return {
    bankCode,
    async autoLogin() {
      return { status: "needs_admin_action", reason: "incompatible_flow", safeSummary: "Bank auto-login requires admin action" };
    },
  };
}

function isScrapeTimeAutoLoginStrategy(strategy: unknown): strategy is BankAutoLoginStrategy {
  if (typeof strategy !== "object" || strategy === null) return false;
  const candidate = strategy as { autoLogin?: unknown };
  return typeof candidate.autoLogin === "function";
}

const ensureAutoLoginBrowser = createProductionScrapeTimeAutoLoginBrowserOpener({
  async ensureBrowserRuntime(bankCode, cdpUrl) {
    const bankCdpUrlKey = `RD_SYNC_BANK_${bankCode.toUpperCase()}_CDP_URL`;
    const ensureBrowser = createEnsureBrowserForBank(bankCode, {
      ...process.env,
      [bankCdpUrlKey]: cdpUrl,
    });
    return ensureBrowser?.() ?? { ok: true, launched: false };
  },
  acquireBrowserSlot: createAcquireBrowserSlotFromEnv(process.env),
  async recordCleanupFailure({ bankCode, failure }) {
    await defaultAuditSink.record(createAuditEvent({
      actorId: "system:auto-login",
      actorRole: null,
      action: BANK_AUTOLOGIN_ACTIONS.FAILED,
      target: "bank_auto_login_browser",
      targetId: null,
      metadata: { bankCode, failure },
    }));
  },
});

const runScrapeTimeAutoLogin = createScrapeTimeAutoLoginRunner({
  adapterRegistry: {
    get(bankCode) {
      const adapter = bankAdapterRegistry.get(bankCode);
      if (!adapter) return undefined;
      return {
        bankCode: adapter.bankCode,
        createAutoLoginStrategy: () => toScrapeTimeAutoLoginStrategy(adapter.createAutoLoginStrategy(), adapter.bankCode),
      };
    },
  },
  autoLoginConfigs: new BankAutoLoginConfigRepository(prisma),
  credentials: new BankCredentialRepository(prisma),
  keyResolver: resolveCredentialKey,
  lock: defaultAutoLoginLock,
  cdpUrlForBankCode: (bankCode) => resolveBankBrowserEnv(bankCode, process.env).cdpUrl || undefined,
  ensureBrowser: ensureAutoLoginBrowser,
  async recordLockReleaseFailure({ bankCode, expiredEventId }) {
    await defaultAuditSink.record(createAuditEvent({
      actorId: "system:auto-login",
      actorRole: null,
      action: BANK_AUTOLOGIN_ACTIONS.FAILED,
      target: "bank_autologin_lock",
      targetId: null,
      metadata: { bankCode, expiredEventId, failure: "lock_release_failed" },
    }));
  },
  async recordCredentialDecryptUse({ bankCode, keyVersion }) {
    await defaultAuditSink.record(createAuditEvent({
      actorId: "system:auto-login",
      actorRole: null,
      action: BANK_CREDENTIAL_ACTIONS.DECRYPT_USE,
      target: "bank_credential",
      targetId: null,
      metadata: { bankCode, keyVersion },
    }));
  },
});

const processor = createIngestionProcessor({
  scrapeRuns: defaultScrapeRunRepository,
  transactions: defaultTransactionRepository,
  adminAlerts: resolveDefaultAlertSink(),
  auditSink: defaultAuditSink,
  resolveScraper: resolveDefaultScraper,
  runScrapeTimeAutoLogin,
});

// ---------------------------------------------------------------------------
// Start the worker
// ---------------------------------------------------------------------------

const worker = createIngestionWorker({
  connection,
  processor,
  concurrency: 2,
  // Bind the real bullmq Worker at the composition root; the factory stays
  // bullmq-free. The cast is the single adapter seam between the library and
  // our structural WorkerConstructor port.
  WorkerCtor: Worker as unknown as WorkerConstructor,
});

console.log("[ingestion-worker] Started. Waiting for jobs on 'bank-transaction-ingestion'...");

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

// How long to wait for in-flight jobs to finish before forcing a hard close.
// Must be shorter than the container's terminationGracePeriodSeconds (default 30s).
const SHUTDOWN_GRACE_MS = 25_000;

async function shutdown(signal: string): Promise<void> {
  console.log(`[ingestion-worker] ${signal} received — shutting down gracefully (${SHUTDOWN_GRACE_MS}ms timeout)...`);

  const graceful = worker.close();
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.warn("[ingestion-worker] Shutdown grace period exceeded — forcing exit.");
      resolve();
    }, SHUTDOWN_GRACE_MS),
  );

  await Promise.race([graceful, timeout]);
  console.log("[ingestion-worker] Stopped.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
