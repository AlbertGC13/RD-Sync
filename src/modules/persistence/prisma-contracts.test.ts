/**
 * Contract tests for Prisma-backed repository implementations.
 *
 * These tests are SKIPPED by default. They require a real PostgreSQL database
 * with the RD-Sync schema applied.
 *
 * To run against a test database:
 *
 *   1. Create a throwaway PostgreSQL database (NEVER use the dev DATABASE_URL).
 *   2. Apply committed migrations:
 *        DATABASE_URL="postgresql://..." pnpm prisma migrate deploy
 *   3. Run the Prisma contract tests:
 *        RD_SYNC_TEST_DATABASE_URL="postgresql://..." pnpm test --reporter=verbose
 *
 * The test suite truncates rows in afterEach to keep each test isolated.
 * RD_SYNC_TEST_DATABASE_URL is intentionally SEPARATE from DATABASE_URL
 * so the production/dev database is never touched during testing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../../generated/prisma/client";

import { PrismaTransactionRepository } from "./prisma-transaction-repository";
import { PrismaScrapeRunRepository } from "./prisma-scrape-run-repository";
import { PrismaAuditSink } from "./prisma-audit-sink";
import { PrismaBankSessionExpiryEpisodeRepository } from "./prisma-bank-session-expiry-episode-repository";
import { PrismaManualRecoveryResolutionAuditOutboxRepository } from "./prisma-manual-recovery-resolution-audit-outbox-repository";
import { deliverManualRecoveryResolutionAudit } from "../bank-sessions/manual-recovery-resolution-audit-delivery";
import { createSetAutoLoginEnabledAndAudit } from "../../app/api/bank-credentials/[bankCode]/auto-login/defaults";
import { BankAutoLoginConfigRepository } from "../bank-auto-login-config/repository";
import { PUBLICATION_CLAIM_TIMEOUT_MS, publishExpiryEpisode, type ExpiryPublicationPublisher } from "../bank-sessions/expiry-episodes";
import { createBankSessionMonitor } from "../bank-sessions";
import { createManualRecoveryReplayAuthorization } from "../bank-sessions/manual-recovery-replay-authorization";
import { InMemoryAuditSink } from "../audit";
import { reserveExpiryPublicationConsumerClaim } from "../bank-sessions/expiry-publication-consumer";

function createPublisherStub(overrides: Partial<ExpiryPublicationPublisher> = {}): ExpiryPublicationPublisher {
  return { schedule: async () => undefined, observe: async () => undefined, ...overrides };
}

import { runTransactionRepositoryContract } from "./contracts/transaction-repository.contract";
import { runScrapeRunRepositoryContract } from "./contracts/scrape-run-repository.contract";
import { runAuditRepositoryContract } from "./contracts/audit-repository.contract";
import { PrismaUserRepository } from "./prisma-user-repository";
import { runUserRepositoryContract } from "./contracts/user-repository.contract";
import { RoleKey } from "../../generated/prisma/enums";

const TEST_DB_URL = process.env.RD_SYNC_TEST_DATABASE_URL;
const hasTestDb = Boolean(TEST_DB_URL);
const MAX_POSTGRES_LOCK_WAIT_ATTEMPTS = 100;
const POSTGRES_CHECK_VIOLATION = "23514";
const requiredExpiryCheckConstraints = [
  "BankSessionExpiryEpisode_publicationState_check",
  "BankSessionExpiryEpisode_consumerAttempt_check",
  "BankSessionExpiryEpisode_terminalFailure_check",
] as const;
const recoveryMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260718014500_add_expiry_consumer_recovery_state/migration.sql", import.meta.url));
const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const manualRecoveryResolutionMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260728120000_add_manual_recovery_resolution_outbox/migration.sql", import.meta.url));
const auditDeliveryMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260728190000_add_manual_recovery_audit_delivery_state/migration.sql", import.meta.url));
const replayAuthorizationMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260728213000_authorize_manual_recovery_replay/migration.sql", import.meta.url));
const terminalFailureMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260728130000_reconcile_expiry_terminal_failures/migration.sql", import.meta.url));

// ---------------------------------------------------------------------------
// Shared test client — one pool for the entire test file.
// ---------------------------------------------------------------------------

let prisma: PrismaClient | undefined;

function missingExpiryCheckConstraints(rows: readonly { conname: string }[]): string[] {
  const present = new Set(rows.map((row) => row.conname));
  return requiredExpiryCheckConstraints.filter((name) => !present.has(name));
}

// Capture original so we can restore it after the suite.
const _originalDatabaseUrl = process.env.DATABASE_URL;

if (hasTestDb) {
  beforeAll(async () => {
    // Repositories call getPrismaClient() which reads DATABASE_URL.
    // Mirror the test URL there so repositories target the same test DB.
    process.env.DATABASE_URL = TEST_DB_URL!;
    const adapter = new PrismaPg({ connectionString: TEST_DB_URL! });
    prisma = new PrismaClient({ adapter });
    const constraints = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conrelid = '"BankSessionExpiryEpisode"'::regclass AND contype = 'c'`;
    const missing = missingExpiryCheckConstraints(constraints);
    if (missing.length > 0) throw new Error(`Missing expiry CHECK constraints: ${missing.join(", ")}; use migrate deploy, not db push`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    // Restore original value (or remove the key if it was unset before).
    if (_originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = _originalDatabaseUrl;
    }
  });
}

// ---------------------------------------------------------------------------
// Cleanup helper — truncates only the tables touched by these tests.
// ---------------------------------------------------------------------------

async function truncateTables(): Promise<void> {
  if (!prisma) return;
  // Order matters: FK children first.
  await prisma.auditEvent.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.scrapeRun.deleteMany();
  await prisma.$executeRawUnsafe('DELETE FROM "ManualRecoveryResolutionAuditOutbox"');
  await prisma.$executeRawUnsafe('DELETE FROM "ManualRecoveryResolution"');
  await prisma.$executeRawUnsafe('DELETE FROM "BankSessionExpiryEpisode"');
  await prisma.bank.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
}

async function openPausedPostgresConnection() {
  if (!TEST_DB_URL) throw new Error("RD_SYNC_TEST_DATABASE_URL is required");
  const pool = new Pool({ connectionString: TEST_DB_URL });
  const client = await pool.connect();
  await client.query("BEGIN");
  const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return { client, pool, pid: identity.rows[0]!.pid };
}

async function closePausedPostgresConnection(connection: Awaited<ReturnType<typeof openPausedPostgresConnection>>) {
  await connection.client.query("ROLLBACK").catch(() => undefined);
  connection.client.release();
  await connection.pool.end();
}

async function waitForLockWait(observer: Awaited<ReturnType<typeof openPausedPostgresConnection>>, holderPid: number): Promise<number> {
  for (let attempts = 0; attempts < MAX_POSTGRES_LOCK_WAIT_ATTEMPTS; attempts += 1) {
    const result = await observer.client.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))",
      [holderPid],
    );
    if (result.rows[0]) return result.rows[0].pid;
  }
  throw new Error("repository query did not enter a PostgreSQL lock wait");
}

// ---------------------------------------------------------------------------
// Prisma transaction repository contract
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("Prisma transaction repository (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  runTransactionRepositoryContract(async () => ({
    repo: new PrismaTransactionRepository(),
    cleanup: truncateTables,
  }));
});

// ---------------------------------------------------------------------------
// Prisma scrape-run repository contract
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("Prisma scrape-run repository (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  runScrapeRunRepositoryContract(async () => ({
    repo: new PrismaScrapeRunRepository(),
    cleanup: truncateTables,
  }));
});

describe.skipIf(!hasTestDb)("Prisma bank-session expiry episode repository (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  beforeEach(truncateTables);
  afterEach(truncateTables);

  async function createUnclaimedEnvelope(repo: PrismaBankSessionExpiryEpisodeRepository, suffix: string) {
    const episode = { bankCode: `claim-${suffix}`, expiredEventId: `event-${suffix}`, runId: `run-${suffix}` };
    await repo.getOrCreate(episode);
    return { ...episode, token: "publication-token" };
  }

  async function publishEnvelope(repo: PrismaBankSessionExpiryEpisodeRepository, suffix: string) {
    const envelope = await createUnclaimedEnvelope(repo, suffix);
    await repo.claimPublication(envelope, envelope.token);
    await repo.markPublicationPublished(envelope, envelope.token);
    return envelope;
  }

  it("persists create/conflict/read/audit acknowledgement/close with PostgreSQL", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const input = { bankCode: "popular", expiredEventId: "event-contract-1", runId: "popular-expiry-event-contract-1" };

    await expect(repo.getOrCreate(input)).resolves.toMatchObject({ created: true, episode: input });
    await expect(repo.getOrCreate({ ...input, expiredEventId: "ignored", runId: "ignored" }))
      .resolves.toMatchObject({ created: false, episode: input });
    await expect(repo.markAuditDelivered(input, "expired")).resolves.toBe(true);
    await expect(repo.markAuditDelivered(input, "expired")).resolves.toBe(false);
    await expect(repo.getOrCreate(input)).resolves.toMatchObject({
      created: false,
      episode: { ...input, expiredAuditDelivered: true },
    });
    await expect(repo.close(input)).resolves.toBe("closed");
    await expect(repo.getOrCreate({ bankCode: "popular", expiredEventId: "event-contract-2", runId: "popular-expiry-event-contract-2" }))
      .resolves.toMatchObject({ created: true });
  });

  it("allows a restarted active monitor to locate and identity-safely close the current episode", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const episode = { bankCode: "popular", expiredEventId: "event-restart", runId: "popular-expiry-event-restart" };

    await repo.getOrCreate(episode);
    await expect(repo.findByBankCode("popular")).resolves.toMatchObject(episode);
    await expect(repo.close(episode)).resolves.toBe("closed");
    await expect(repo.findByBankCode("popular")).resolves.toBeNull();
  });

  it("does not let a delayed stale close remove a replacement episode", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const firstEpisode = { bankCode: "popular", expiredEventId: "event-stale-e1", runId: "popular-expiry-event-stale-e1" };
    const replacementEpisode = { bankCode: "popular", expiredEventId: "event-stale-e2", runId: "popular-expiry-event-stale-e2" };

    await expect(repo.getOrCreate(firstEpisode)).resolves.toMatchObject({ created: true, episode: firstEpisode });
    await expect(repo.close(firstEpisode)).resolves.toBe("closed");
    await expect(repo.getOrCreate(replacementEpisode)).resolves.toMatchObject({ created: true, episode: replacementEpisode });
    await expect(repo.close(firstEpisode)).resolves.toBe("missing_or_stale");
    await expect(repo.findByBankCode("popular")).resolves.toMatchObject({
      ...replacementEpisode,
      expiredAuditDelivered: false,
      restoredAuditDelivered: false,
      publicationState: "pending",
      publicationClaimToken: null,
      publicationFailureReportedAt: null,
    });
  });

  it("linearizes concurrent episode creation, audit markers, and identity-safe close", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const first = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const second = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const firstCandidate = { bankCode: "popular", expiredEventId: "event-concurrent-a", runId: "popular-expiry-event-concurrent-a" };
    const secondCandidate = { bankCode: "popular", expiredEventId: "event-concurrent-b", runId: "popular-expiry-event-concurrent-b" };
    const created = await Promise.all([first.getOrCreate(firstCandidate), second.getOrCreate(secondCandidate)]);
    expect(created.filter((result) => result.created)).toHaveLength(1);
    const winner = created.find((result) => result.created)?.episode;
    expect(winner).toBeDefined();
    for (const result of created) {
      expect(result.episode).toMatchObject(winner!);
    }

    const expiredMarkers = await Promise.all([
      first.markAuditDelivered(winner!, "expired"),
      second.markAuditDelivered(winner!, "expired"),
    ]);
    expect(expiredMarkers.filter(Boolean)).toHaveLength(1);
    await expect(new PrismaBankSessionExpiryEpisodeRepository(prisma).isAuditDelivered(winner!, "expired")).resolves.toBe(true);

    const restoredMarkers = await Promise.all([
      first.markAuditDelivered(winner!, "restored"),
      second.markAuditDelivered(winner!, "restored"),
    ]);
    expect(restoredMarkers.filter(Boolean)).toHaveLength(1);
    const closes = await Promise.all([first.close(winner!), second.close(winner!)]);
    expect(closes.filter((result) => result === "closed")).toHaveLength(1);
  });

  it("recovers acknowledgement loss and enforces DB-clock skew constraints through the production publisher", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const episode = { bankCode: "popular", expiredEventId: "event-ack-loss", runId: "popular-expiry-event-ack-loss" };
    const accepted: Array<{ bankCode: string; expiredEventId: string; runId: string; token: string }> = [];
    await repo.getOrCreate(episode);
    for (const tuple of [["invalid", null, null], ["pending", "token", null], ["publishing", null, null], ["publishing", "\t", null], ["published", null, null], ["published", " ", null], ["published", "token", new Date()], ["cancelled", null, new Date()]] as const)
      await expect(prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "publicationState" = ${tuple[0]}, "publicationClaimToken" = ${tuple[1]}, "publicationFailureReportedAt" = ${tuple[2]} WHERE "bankCode" = ${episode.bankCode}`).rejects.toThrow();
    await expect(publishExpiryEpisode(repo, episode, "token-a", createPublisherStub({ schedule: async (job) => { accepted.push(job); throw new Error("acknowledgement lost"); } }))).rejects.toThrow("acknowledgement lost");
    await expect(repo.findByBankCode(episode.bankCode)).resolves.toMatchObject({ publicationClaimToken: "token-a", publicationFailureReportedAt: expect.any(Date) });
    await expect(publishExpiryEpisode(repo, episode, "token-b", createPublisherStub({ schedule: async (job) => { accepted.push(job); } }))).resolves.toBe(true);
    expect(accepted).toEqual([{ ...episode, token: "token-a" }, { ...episode, token: "token-a" }]);
    await expect(repo.findByBankCode(episode.bankCode)).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a", publicationFailureReportedAt: null });

    const crash = { bankCode: "bhd", expiredEventId: "event-crash", runId: "bhd-expiry-event-crash" };
    await repo.getOrCreate(crash);
    await repo.claimPublication(crash, "token-a");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + PUBLICATION_CLAIM_TIMEOUT_MS * 2));
      await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "updatedAt" = NOW() WHERE "bankCode" = ${crash.bankCode}`;
      await expect(publishExpiryEpisode(repo, crash, "token-b", createPublisherStub({ schedule: async (job) => { accepted.push(job); } }))).resolves.toBe(false);
      await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "updatedAt" = NOW() - (${PUBLICATION_CLAIM_TIMEOUT_MS + 1} * INTERVAL '1 millisecond') WHERE "bankCode" = ${crash.bankCode}`;
      await expect(publishExpiryEpisode(repo, crash, "token-b", createPublisherStub({ schedule: async (job) => { accepted.push(job); } }))).resolves.toBe(true);
    } finally { vi.useRealTimers(); }
    expect(accepted.at(-1)).toEqual({ ...crash, token: "token-a" });
    const cancellation = { bankCode: "banreservas", expiredEventId: "event-cancel", runId: "banreservas-expiry-event-cancel" };
    await repo.getOrCreate(cancellation); await repo.claimPublication(cancellation, "token-a"); await repo.cancelPublication(cancellation);
    await expect(repo.findByBankCode(cancellation.bankCode)).resolves.toMatchObject({ publicationState: "cancelled", publicationClaimToken: null, publicationFailureReportedAt: null });
  });

  it("blocks the real publisher behind a committed restoration audit and never enqueues", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    // Arrange
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const episode = { bankCode: "popular", expiredEventId: "event-restoration", runId: "popular-expiry-event-restoration" };
    const schedule = vi.fn();
    await repo.getOrCreate(episode);
    const holder = await openPausedPostgresConnection();
    try {
      await holder.client.query('UPDATE "BankSessionExpiryEpisode" SET "restoredAuditDeliveredAt" = NOW() WHERE "bankCode" = $1', [episode.bankCode]);

      // Act
      const competitor = publishExpiryEpisode(repo, episode, "claim", createPublisherStub({ schedule }));
      expect(await waitForLockWait(holder, holder.pid)).not.toBe(holder.pid);
      await holder.client.query("COMMIT");

      // Assert
      await expect(competitor).resolves.toBe(false);
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      await closePausedPostgresConnection(holder);
    }
  });

  it("blocks the real restoration monitor behind publication before closing once", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    // Arrange: a claimed publication holds the row while the monitor observes restoration.
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const episode = { bankCode: "popular", expiredEventId: "event-publication", runId: "popular-expiry-event-publication" };
    const sequence: string[] = [];
    const audit = new InMemoryAuditSink();
    const auditSink = { record: async (event: Parameters<InMemoryAuditSink["record"]>[0]) => { if (event.action === "bank_session.restored") sequence.push("restoration audit"); await audit.record(event); } };
    let active = false;
    const monitor = createBankSessionMonitor({
      check: async () => ({ status: active ? "active" : "expired", checkedAt: "2026-07-13T00:00:00.000Z", safeSummary: "safe" }),
      alertSink: { notifySessionAttention: async () => undefined }, auditSink, intervalMs: 1,
      monitorMode: { mode: "expiry_events", bankCode: episode.bankCode, episodes: repo, createExpiredEventId: () => episode.expiredEventId },
    });
    await monitor.tick();
    active = true;
    const originalCancel = repo.cancelPublication.bind(repo);
    vi.spyOn(repo, "cancelPublication").mockImplementation(async (observedEpisode) => { const cancelled = await originalCancel(observedEpisode); if (cancelled) sequence.push("successful cancelPublication"); return cancelled; });
    const originalClose = repo.close.bind(repo);
    const close = vi.spyOn(repo, "close").mockImplementation(async (observedEpisode) => { const result = await originalClose(observedEpisode); if (result === "closed") sequence.push("close"); return result; });
    const holder = await openPausedPostgresConnection();
    try {
      await holder.client.query('UPDATE "BankSessionExpiryEpisode" SET "publicationState" = $1, "publicationClaimToken" = $2 WHERE "bankCode" = $3', ["publishing", "claim", episode.bankCode]);
      // Act: prove PostgreSQL blocks the monitor before releasing the publication claim.
      const restoration = monitor.tick();
      expect(await waitForLockWait(holder, holder.pid)).not.toBe(holder.pid);
      await holder.client.query("COMMIT");
      await restoration;
      // Assert: restoration persists, cancels the claim, then closes the same episode.
      expect(sequence).toEqual(["restoration audit", "successful cancelPublication", "close"]);
      expect(close).toHaveBeenCalledTimes(1);
      await expect(repo.findByBankCode(episode.bankCode)).resolves.toBeNull();
    } finally { await closePausedPostgresConnection(holder); }
  });

  it("claims only an independently created exact published envelope", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "exact");

    await expect(repo.claimConsumerAttempt(envelope, "consumer-winner")).resolves.toBe(true);
    await expect(repo.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ consumerClaimToken: "consumer-winner" });
  });

  it("loses when the independently created row is not the envelope bank", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "bank-mismatch");

    await expect(repo.claimConsumerAttempt({ ...envelope, bankCode: "claim-other-bank" }, "consumer-loser")).resolves.toBe(false);
  });

  it("loses when the independently created row is missing", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await createUnclaimedEnvelope(repo, "missing-seed");

    await expect(repo.claimConsumerAttempt({ ...envelope, bankCode: "claim-missing" }, "consumer-loser")).resolves.toBe(false);
  });

  it.each(["expiredEventId", "runId", "token"] as const)("loses when the independently created published envelope has a different %s", async (field) => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, `mismatch-${field}`);
    const staleEnvelope = { ...envelope, [field]: `other-${field}` };

    await expect(repo.claimConsumerAttempt(staleEnvelope, "consumer-loser")).resolves.toBe(false);
  });

  it("loses when the independently created published row was restored", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "restored");
    await repo.markAuditDelivered(envelope, "restored");

    await expect(repo.claimConsumerAttempt(envelope, "consumer-loser")).resolves.toBe(false);
  });

  it.each(["pending", "publishing", "cancelled"] as const)("loses when the independently created row is %s", async (state) => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await createUnclaimedEnvelope(repo, `state-${state}`);
    if (state !== "pending") await repo.claimPublication(envelope, envelope.token);
    if (state === "cancelled") await repo.cancelPublication(envelope);

    await expect(repo.claimConsumerAttempt(envelope, "consumer-loser")).resolves.toBe(false);
  });

  it("loses when the independently created published row already has a consumer claim", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "existing-claim");
    await repo.claimConsumerAttempt(envelope, "consumer-first");

    await expect(repo.claimConsumerAttempt(envelope, "consumer-second")).resolves.toBe(false);
  });

  it.each(["", " ", "\t", "\n"])("rejects a %j consumer claim token before inspecting an independently created row", async (token) => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await createUnclaimedEnvelope(repo, `blank-${JSON.stringify(token)}`);

    await expect(repo.claimConsumerAttempt(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
  });

  it("enforces the named NULL-safe consumer recovery tuple constraint", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await createUnclaimedEnvelope(repo, "check");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      for (const [token, state, restored] of [[" ", "reserved", false], ["legacy-token", null, false], [null, "reserved", false], ["valid-token", "unknown", false], ["reserved-token", "reserved", true]] as const) {
        await expect(pool.query('UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = $1, "consumerAttemptState" = $2, "restoredAuditDeliveredAt" = CASE WHEN $3 THEN NOW() ELSE NULL END WHERE "bankCode" = $4', [token, state, restored, envelope.bankCode]))
          .rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "BankSessionExpiryEpisode_consumerAttempt_check" });
      }
      for (const state of ["reserved", "mutation_started", "manual_recovery_required", "resolved"] as const) {
        await expect(pool.query('UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = $1, "consumerAttemptState" = $2, "restoredAuditDeliveredAt" = NULL WHERE "bankCode" = $3', ["consumer-valid", state, envelope.bankCode])).resolves.toMatchObject({ rowCount: 1 });
      }
      for (const state of ["mutation_started", "manual_recovery_required", "resolved"] as const) {
        await expect(pool.query('UPDATE "BankSessionExpiryEpisode" SET "consumerAttemptState" = $1, "restoredAuditDeliveredAt" = NOW() WHERE "bankCode" = $2', [state, envelope.bankCode])).resolves.toMatchObject({ rowCount: 1 });
      }
    } finally {
      await pool.end();
    }
  });

  it("declares the committed recovery migration as one atomic transaction", async () => {
    const migration = await readFile(recoveryMigrationPath, "utf8");
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("backfills only unrestored legacy claims through the committed recovery migration", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const restored = await createUnclaimedEnvelope(repo, "legacy-restored");
    const active = await createUnclaimedEnvelope(repo, "legacy-active");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('ALTER TABLE "BankSessionExpiryEpisode" DROP CONSTRAINT "BankSessionExpiryEpisode_consumerAttempt_check", DROP COLUMN "consumerAttemptState", ADD CONSTRAINT "BankSessionExpiryEpisode_consumerClaimToken_check" CHECK ("consumerClaimToken" IS NULL OR "consumerClaimToken" ~ \'[^[:space:]]\')');
      await client.query('UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = $1, "restoredAuditDeliveredAt" = NOW() WHERE "bankCode" = $2', ["legacy-restored-token", restored.bankCode]);
      await client.query('UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = $1 WHERE "bankCode" = $2', ["legacy-active-token", active.bankCode]);
      const migration = (await readFile(recoveryMigrationPath, "utf8")).replace(/^BEGIN;\s*/, "").replace(/\s*COMMIT;\s*$/, "");
      await client.query(migration);
      const rows = await client.query<{ bankCode: string; consumerClaimToken: string | null; consumerAttemptState: string | null }>('SELECT "bankCode", "consumerClaimToken", "consumerAttemptState" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ANY($1)', [[restored.bankCode, active.bankCode]]);
      expect(rows.rows).toEqual(expect.arrayContaining([
        { bankCode: restored.bankCode, consumerClaimToken: null, consumerAttemptState: null },
        { bankCode: active.bankCode, consumerClaimToken: "legacy-active-token", consumerAttemptState: "reserved" },
      ]));
    } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); await pool.end(); }
  });

  it("blocks a Prisma contender behind a direct pg exact winner and leaves one durable claim", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "overlap");
    const holder = await openPausedPostgresConnection();
    const observer = await openPausedPostgresConnection();
    try {
      // Mirror the repository CAS exactly; independent matrices pin every predicate.
      const winner = await holder.client.query(
        'UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = $1, "consumerAttemptState" = $2 WHERE "bankCode" = $3 AND "expiredEventId" = $4 AND "runId" = $5 AND "publicationClaimToken" = $6 AND "publicationState" = $7 AND "restoredAuditDeliveredAt" IS NULL AND "consumerClaimToken" IS NULL AND "consumerAttemptState" IS NULL RETURNING "bankCode"',
        ["consumer-winner", "reserved", envelope.bankCode, envelope.expiredEventId, envelope.runId, envelope.token, "published"],
      );
      expect(winner.rowCount).toBe(1);
      const contender = repo.claimConsumerAttempt(envelope, "consumer-contender");
      expect(await waitForLockWait(observer, holder.pid)).not.toBe(holder.pid);
      await holder.client.query("COMMIT");

      await expect(contender).resolves.toBe(false);
      await expect(repo.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ consumerClaimToken: "consumer-winner" });
    } finally {
      await closePausedPostgresConnection(observer);
      await closePausedPostgresConnection(holder);
    }
  });

  it("linearizes deterministic consumer claim acquisition, crash resume, and mutation no-resume", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const first = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const second = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(first, "resumable-race");
    const gate = { check: async () => "eligible" as const };
    const results = await Promise.all([
      reserveExpiryPublicationConsumerClaim(first, envelope, gate),
      reserveExpiryPublicationConsumerClaim(second, envelope, gate),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["claim_acquired", "claim_resumed"]);
    await expect(reserveExpiryPublicationConsumerClaim(first, envelope, gate)).resolves.toEqual({ status: "claim_resumed" });
    const claim = (await first.findByBankCode(envelope.bankCode))!.consumerClaimToken!;
    await first.markConsumerMutationStarted(envelope, claim);
    await expect(reserveExpiryPublicationConsumerClaim(second, envelope, gate)).resolves.toEqual({ status: "ignored_already_claimed" });
  });
  it("rejects stale, restored, and invalid consumer claim deliveries without writes", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "resumable-stale");
    const gate = { check: vi.fn().mockResolvedValue("eligible" as const) };
    for (const stale of [{ ...envelope, token: "wrong" }, { ...envelope, runId: "wrong" }]) await expect(reserveExpiryPublicationConsumerClaim(repo, stale, gate)).resolves.toEqual({ status: "ignored_stale_envelope" });
    await repo.markAuditDelivered(envelope, "restored");
    await expect(reserveExpiryPublicationConsumerClaim(repo, envelope, gate)).resolves.toEqual({ status: "ignored_stale_envelope" });
    await expect(repo.claimConsumerAttempt(envelope, " ")).rejects.toThrow("Consumer claim token must be nonblank");
    expect(gate.check).not.toHaveBeenCalled();
  });

  it("enforces the consumer recovery tuple and independent transition predicates", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "recovery-matrix");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      await expect(pool.query('UPDATE "BankSessionExpiryEpisode" SET "consumerAttemptState" = $1 WHERE "bankCode" = $2', ["reserved", envelope.bankCode]))
        .rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION });
      await expect(repo.claimConsumerAttempt(envelope, "consumer-token")).resolves.toBe(true);
      for (const staleEnvelope of [{ ...envelope, bankCode: "other-bank" }, { ...envelope, expiredEventId: "other-event" }, { ...envelope, runId: "other-run" }, { ...envelope, token: "wrong-token" }]) {
        await expect(repo.markConsumerMutationStarted(staleEnvelope, "consumer-token")).resolves.toBe(false);
      }
      await expect(repo.markConsumerMutationStarted(envelope, "wrong-owner")).resolves.toBe(false);
      await expect(repo.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(false);
      await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "publicationState" = 'publishing' WHERE "bankCode" = ${envelope.bankCode}`;
      await expect(repo.markConsumerMutationStarted(envelope, "consumer-token")).resolves.toBe(false);
      await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "publicationState" = 'published' WHERE "bankCode" = ${envelope.bankCode}`;
      await expect(repo.markConsumerMutationStarted(envelope, "consumer-token")).resolves.toBe(true);
      await expect(repo.markConsumerManualRecoveryRequired(envelope, "wrong-owner")).resolves.toBe(false);
      await expect(repo.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(true);
      await expect(repo.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ consumerAttemptState: "manual_recovery_required", consumerClaimToken: "consumer-token" });
      for (const token of ["", " ", "\t", "\n"]) {
        await expect(repo.markConsumerMutationStarted(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
        await expect(repo.markConsumerManualRecoveryRequired(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
      }
      await expect(repo.markConsumerMutationStarted(envelope, "consumer-token")).resolves.toBe(false);
      await expect(repo.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(false);
      await expect(repo.close(envelope)).resolves.toBe("retained_for_recovery");
    } finally { await pool.end(); }
  });

  it("linearizes restoration against reserved and mutation-started consumer transitions", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const reserved = await publishEnvelope(repo, "recovery-reserved-race");
    await repo.claimConsumerAttempt(reserved, "reserved-token");
    const reservedHolder = await openPausedPostgresConnection();
    const reservedObserver = await openPausedPostgresConnection();
    try {
      await reservedHolder.client.query('SELECT "bankCode" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1 FOR UPDATE', [reserved.bankCode]);
      const restoration = repo.markAuditDelivered(reserved, "restored");
      expect(await waitForLockWait(reservedObserver, reservedHolder.pid)).not.toBe(reservedHolder.pid);
      const contender = repo.markConsumerMutationStarted(reserved, "reserved-token");
      await reservedHolder.client.query("COMMIT");
      await expect(restoration).resolves.toBe(true);
      await expect(contender).resolves.toBe(false);
      await expect(repo.findByBankCode(reserved.bankCode)).resolves.toMatchObject({ consumerClaimToken: null, consumerAttemptState: null });
      await expect(repo.close(reserved)).resolves.toBe("closed");
    } finally { await closePausedPostgresConnection(reservedObserver); await closePausedPostgresConnection(reservedHolder); }

    const started = await publishEnvelope(repo, "recovery-started-race");
    await repo.claimConsumerAttempt(started, "started-token");
    const startedHolder = await openPausedPostgresConnection();
    const startedObserver = await openPausedPostgresConnection();
    try {
      await startedHolder.client.query('SELECT "bankCode" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1 FOR UPDATE', [started.bankCode]);
      const mutationStarted = repo.markConsumerMutationStarted(started, "started-token");
      expect(await waitForLockWait(startedObserver, startedHolder.pid)).not.toBe(startedHolder.pid);
      const restoration = repo.markAuditDelivered(started, "restored");
      await startedHolder.client.query("COMMIT");
      await expect(mutationStarted).resolves.toBe(true);
      await expect(restoration).resolves.toBe(true);
      await expect(repo.close(started)).resolves.toBe("retained_for_recovery");
      await expect(repo.findByBankCode(started.bankCode)).resolves.toMatchObject({ consumerClaimToken: "started-token", consumerAttemptState: "mutation_started" });
    } finally { await closePausedPostgresConnection(startedObserver); await closePausedPostgresConnection(startedHolder); }
  });

  it("atomically resolves exact manual recovery ownership and preserves durable records after close", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "restored-recovery");
    await expect(repo.claimConsumerAttempt(envelope, "recovery-token")).resolves.toBe(true);
    await expect(repo.markConsumerMutationStarted(envelope, "recovery-token")).resolves.toBe(true);
    await expect(repo.markAuditDelivered(envelope, "restored")).resolves.toBe(true);
    await expect(repo.markConsumerManualRecoveryRequired(envelope, "recovery-token")).resolves.toBe(true);
    await expect(repo.close(envelope)).resolves.toBe("retained_for_recovery");
    const command = { operatorId: "admin-recovery", decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" } } as const;
    await expect(repo.resolveConsumerManualRecovery(envelope, "wrong-owner", command)).resolves.toBeNull();
    const result = await repo.resolveConsumerManualRecovery(envelope, "recovery-token", command);
    expect(result).toMatchObject({ bankCode: envelope.bankCode, decision: command.decision, operatorId: command.operatorId, resolvedAt: expect.any(Date) });
    await expect(repo.resolveConsumerManualRecovery(envelope, "recovery-token", command)).resolves.toBeNull();
    await expect(repo.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ restoredAuditDelivered: true, consumerClaimToken: "recovery-token", consumerAttemptState: "resolved" });
    await expect(repo.close(envelope)).resolves.toBe("closed");
    await expect(prisma.manualRecoveryResolution.count()).resolves.toBe(1);
    await expect(prisma.manualRecoveryResolutionAuditOutbox.count({ where: { resolutionId: result!.id, state: "pending" } })).resolves.toBe(1);
  });

  it("rolls back resolution when PostgreSQL rejects the pending outbox and elects one concurrent winner", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const command = { operatorId: "admin-atomic", decision: { outcome: "safe_to_retry", reason: "verified_no_mutation" } } as const;
    const failed = await publishEnvelope(repo, "resolution-outbox-failure");
    await repo.claimConsumerAttempt(failed, "consumer-token"); await repo.markConsumerMutationStarted(failed, "consumer-token"); await repo.markConsumerManualRecoveryRequired(failed, "consumer-token");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      await pool.query('CREATE FUNCTION "fail_manual_resolution_outbox"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'outbox failed\'; END; $$');
      await pool.query('CREATE TRIGGER "fail_manual_resolution_outbox" BEFORE INSERT ON "ManualRecoveryResolutionAuditOutbox" FOR EACH ROW EXECUTE FUNCTION "fail_manual_resolution_outbox"()');
      await expect(repo.resolveConsumerManualRecovery(failed, "consumer-token", command)).rejects.toThrow();
      await expect(repo.findByBankCode(failed.bankCode)).resolves.toMatchObject({ consumerAttemptState: "manual_recovery_required" });
      await expect(prisma.manualRecoveryResolution.count()).resolves.toBe(0);
      await pool.query('DROP TRIGGER "fail_manual_resolution_outbox" ON "ManualRecoveryResolutionAuditOutbox"');
      await pool.query('DROP FUNCTION "fail_manual_resolution_outbox"()');
    } finally { await pool.end(); }

    const envelope = await publishEnvelope(repo, "resolution-contenders");
    await repo.claimConsumerAttempt(envelope, "consumer-token"); await repo.markConsumerMutationStarted(envelope, "consumer-token"); await repo.markConsumerManualRecoveryRequired(envelope, "consumer-token");
    const results = await Promise.all([repo.resolveConsumerManualRecovery(envelope, "consumer-token", command), repo.resolveConsumerManualRecovery(envelope, "consumer-token", command)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(prisma.manualRecoveryResolution.count()).resolves.toBe(1);
    await expect(prisma.manualRecoveryResolutionAuditOutbox.count()).resolves.toBe(1);
  });

  it("linearizes terminal markers, upgrades missing evidence, and keeps audit metadata allowlisted", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const first = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const second = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(first, "terminal-race");
    const results = await Promise.all([
      first.reconcileTerminalFailure(envelope, "job_missing", new Date("2026-07-28T13:00:00.000Z")),
      second.reconcileTerminalFailure(envelope, "job_failed", new Date("2026-07-28T13:00:01.000Z")),
    ]);
    expect(results.some((result) => result.status === "reconciled")).toBe(true);
    await expect(first.reconcileTerminalFailure(envelope, "job_failed", new Date("2026-07-28T13:00:02.000Z"))).resolves.toMatchObject({ status: "already_reconciled" });
    await expect(first.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ terminalFailureReason: "job_failed", terminalFailureReconciledAt: expect.any(Date) });
    const audit = await prisma.auditEvent.findUnique({ where: { id: `bank-session-expiry-terminal:${envelope.bankCode}:${envelope.expiredEventId}:${envelope.runId}` } });
    expect(audit).toMatchObject({ action: "bank_autologin.needs_admin_action", metadata: { bankCode: envelope.bankCode, expiredEventId: envelope.expiredEventId, runId: envelope.runId, reason: "job_failed" } });
    expect(JSON.stringify(audit?.metadata)).not.toContain(envelope.token);
    await expect(prisma.auditEvent.count({ where: { id: audit!.id } })).resolves.toBe(1);
  });

  it.each(["bankCode", "expiredEventId", "runId", "token"] as const)("ignores exact stale terminal envelopes with a different %s", async (field) => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, `terminal-stale-${field}`);
    await expect(repo.reconcileTerminalFailure({ ...envelope, [field]: `wrong-${field}` }, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    await expect(prisma.auditEvent.count()).resolves.toBe(0);
  });

  it("ignores restoration-first and replacement replay while terminal-first preserves manual recovery", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const restored = await publishEnvelope(repo, "terminal-restored");
    await repo.markAuditDelivered(restored, "restored");
    await expect(repo.reconcileTerminalFailure(restored, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    const started = await publishEnvelope(repo, "terminal-started");
    await repo.claimConsumerAttempt(started, "terminal-owner");
    await repo.markConsumerMutationStarted(started, "terminal-owner");
    await expect(repo.reconcileTerminalFailure(started, "job_failed", new Date())).resolves.toMatchObject({ status: "reconciled" });
    await expect(repo.findByBankCode(started.bankCode)).resolves.toMatchObject({ consumerAttemptState: "manual_recovery_required" });
    const replay = await publishEnvelope(repo, "terminal-replay");
    await repo.reconcileTerminalFailure(replay, "job_failed", new Date());
    await repo.close(replay);
    const replacement = { ...replay, expiredEventId: "replacement-event", runId: "replacement-run" };
    await repo.getOrCreate(replacement);
    await expect(repo.reconcileTerminalFailure(replay, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    await expect(repo.findByBankCode(replay.bankCode)).resolves.toMatchObject({ bankCode: replacement.bankCode, expiredEventId: replacement.expiredEventId, runId: replacement.runId });
    const pending = await createUnclaimedEnvelope(repo, "terminal-pending");
    await expect(repo.reconcileTerminalFailure(pending, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    const resolved = await publishEnvelope(repo, "terminal-resolved");
    await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = 'resolved-owner', "consumerAttemptState" = 'resolved' WHERE "bankCode" = ${resolved.bankCode}`;
    await expect(repo.reconcileTerminalFailure(resolved, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    await expect(prisma.auditEvent.count({ where: { targetId: `${resolved.bankCode}:${resolved.expiredEventId}:${resolved.runId}` } })).resolves.toBe(0);

  });

  it("rolls back terminal marker and consumer state when audit persistence fails", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await publishEnvelope(repo, "terminal-audit-rollback");
    await repo.claimConsumerAttempt(envelope, "terminal-owner");
    await repo.markConsumerMutationStarted(envelope, "terminal-owner");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      await pool.query('CREATE FUNCTION "fail_terminal_audit"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'audit failed\'; END; $$');
      await pool.query('CREATE TRIGGER "fail_terminal_audit" BEFORE INSERT OR UPDATE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION "fail_terminal_audit"()');
      await expect(repo.reconcileTerminalFailure(envelope, "job_failed", new Date())).rejects.toThrow();
      await expect(repo.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ terminalFailureReason: null, terminalFailureReconciledAt: null, consumerAttemptState: "mutation_started" });
      await expect(prisma.auditEvent.count()).resolves.toBe(0);
      await pool.query('DROP TRIGGER "fail_terminal_audit" ON "AuditEvent"');
      await pool.query('DROP FUNCTION "fail_terminal_audit"()');
    } finally { await pool.end(); }
  });

  it("enforces the named terminal tuple constraint", async () => {
    const migration = await readFile(terminalFailureMigrationPath, "utf8");
    expect(migration).toContain('CONSTRAINT "BankSessionExpiryEpisode_terminalFailure_check" CHECK');
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const envelope = await createUnclaimedEnvelope(repo, "terminal-check");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      for (const [reason, at, state, token] of [["job_failed", null, "published", "token"], ["unknown", new Date(), "published", "token"]] as const) {
        await expect(pool.query('UPDATE "BankSessionExpiryEpisode" SET "terminalFailureReason" = $1, "terminalFailureReconciledAt" = $2, "publicationState" = $3, "publicationClaimToken" = $4 WHERE "bankCode" = $5', [reason, at, state, token, envelope.bankCode])).rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "BankSessionExpiryEpisode_terminalFailure_check" });
      }
    } finally { await pool.end(); }
  });
});
describe("Manual recovery resolution schema contract", () => {
  it("declares durable resolution and pending audit-outbox models with independent identities", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const migration = await readFile(manualRecoveryResolutionMigrationPath, "utf8");

    expect(schema).toContain("model ManualRecoveryResolution {");
    expect(schema).toMatch(/expiredEventId\s+String\s+@unique/);
    expect(schema).toContain("@@unique([bankCode, runId])");
    expect(schema).toMatch(/resolvedAt\s+DateTime\s+@default\(now\(\)\)/);
    expect(schema).toContain("model ManualRecoveryResolutionAuditOutbox {");
    expect(schema).toMatch(/resolutionId\s+String\s+@unique/);
    expect(schema).toMatch(/state\s+String\s+@default\("pending"\)/);
    expect(migration).toContain('CONSTRAINT "ManualRecoveryResolution_outcomeReason_check" CHECK');
    expect(migration).toContain('CONSTRAINT "ManualRecoveryResolution_operatorId_check" CHECK');
    expect(migration).toContain("CONSTRAINT \"ManualRecoveryResolutionAuditOutbox_state_check\" CHECK (\"state\" = 'pending')");
    expect(migration).toContain('FOREIGN KEY ("resolutionId") REFERENCES "ManualRecoveryResolution"("id") ON DELETE RESTRICT');
    expect(migration).toContain('CREATE UNIQUE INDEX "ManualRecoveryResolution_expiredEventId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "ManualRecoveryResolution_bankCode_runId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "ManualRecoveryResolutionAuditOutbox_resolutionId_key"');
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("does not couple durable recovery records to the deletable expiry episode or sensitive delivery state", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const migration = await readFile(manualRecoveryResolutionMigrationPath, "utf8");
    const resolutionModels = schema.slice(schema.indexOf("model ManualRecoveryResolution {"), schema.indexOf("// Change 4:"));
    const persistedContract = `${resolutionModels}\n${migration}`;

    expect(migration).not.toContain('REFERENCES "BankSessionExpiryEpisode"');
    expect(persistedContract).not.toMatch(/claimToken|publicationToken|credential|ciphertext|secret|errorMessage|errorDetail/i);
  });

  it("declares replay authorization identity, fail-closed tuple constraints, and partial uniqueness", async () => {
    const [schema, migration] = await Promise.all([readFile(schemaPath, "utf8"), readFile(replayAuthorizationMigrationPath, "utf8")]);
    expect(schema).toMatch(/replayExpiredEventId\s+String\?\s+@unique/);
    expect(schema).toMatch(/replayRunId\s+String\?\s+@unique/);
    expect(schema).toMatch(/replayAuthorizedAt\s+DateTime\?/);
    expect(migration).toContain('CONSTRAINT "ManualRecoveryResolution_replayTuple_check" CHECK');
    expect(migration).toContain('CONSTRAINT "ManualRecoveryResolution_replayDecision_check" CHECK');
    expect(migration).toContain('CONSTRAINT "ManualRecoveryResolution_replayId_check" CHECK');
    expect(migration).toContain('CREATE UNIQUE INDEX "ManualRecoveryResolution_replayExpiredEventId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "ManualRecoveryResolution_replayRunId_key"');
    expect(migration).not.toMatch(/claimToken|publicationToken|credential|ciphertext|secret|errorMessage|errorDetail/i);
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });
});

describe.skipIf(!hasTestDb)("Prisma manual recovery resolution schema (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  beforeEach(truncateTables);
  afterEach(truncateTables);

  it("enforces valid resolution decisions, nonblank operator identity, and pending-only causal outbox rows", async () => {
    if (!TEST_DB_URL) throw new Error("RD_SYNC_TEST_DATABASE_URL is required");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const created = await pool.query<{ id: string; resolvedAt: Date }>(
        'INSERT INTO "ManualRecoveryResolution" ("id", "expiredEventId", "bankCode", "runId", "outcome", "reason", "operatorId") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "id", "resolvedAt"',
        ["resolution-id", "resolution-event", "resolution-bank", "resolution-run", "safe_to_retry", "verified_no_mutation", "admin-resolution"],
      );
      const resolution = created.rows[0]!;
      expect(resolution.resolvedAt).toBeInstanceOf(Date);
      await expect(pool.query('INSERT INTO "ManualRecoveryResolutionAuditOutbox" ("id", "resolutionId") VALUES ($1, $2) RETURNING "state"', ["resolution-outbox-id", resolution.id]))
        .resolves.toMatchObject({ rows: [{ state: "pending" }] });

      for (const [outcome, reason] of [["safe_to_retry", "verified_mutation"], ["mutation_confirmed", "closed_without_retry"], ["resolved_no_retry", "verified_no_mutation"]]) {
        await expect(pool.query('INSERT INTO "ManualRecoveryResolution" ("id", "expiredEventId", "bankCode", "runId", "outcome", "reason", "operatorId") VALUES ($1, $2, $3, $4, $5, $6, $7)', [`invalid-id-${outcome}-${reason}`, `invalid-${outcome}-${reason}`, "invalid-bank", `invalid-run-${outcome}`, outcome, reason, "admin-resolution"]))
          .rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolution_outcomeReason_check" });
      }
      await expect(pool.query('INSERT INTO "ManualRecoveryResolution" ("id", "expiredEventId", "bankCode", "runId", "outcome", "reason", "operatorId") VALUES ($1, $2, $3, $4, $5, $6, $7)', ["blank-operator-id", "blank-operator", "blank-bank", "blank-run", "safe_to_retry", "verified_no_mutation", " \t "]))
        .rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolution_operatorId_check" });
      await expect(pool.query('UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = $1 WHERE "resolutionId" = $2', ["published", resolution.id]))
        .rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolutionAuditOutbox_deliveryState_check" });
      await expect(pool.query('INSERT INTO "ManualRecoveryResolution" ("id", "expiredEventId", "bankCode", "runId", "outcome", "reason", "operatorId") VALUES ($1, $2, $3, $4, $5, $6, $7)', ["duplicate-resolution-id", "duplicate-resolution-event", "resolution-bank", "resolution-run", "safe_to_retry", "verified_no_mutation", "admin-resolution"]))
        .rejects.toMatchObject({ code: "23505", constraint: "ManualRecoveryResolution_bankCode_runId_key" });
      await expect(pool.query('INSERT INTO "ManualRecoveryResolutionAuditOutbox" ("id", "resolutionId") VALUES ($1, $2)', ["duplicate-outbox-id", resolution.id]))
        .rejects.toMatchObject({ code: "23505", constraint: "ManualRecoveryResolutionAuditOutbox_resolutionId_key" });
    } finally {
      await pool.end();
    }
  });

  it("keeps resolution and its unique outbox after the matching expiry episode is deleted", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const episode = { bankCode: "durable-bank", expiredEventId: "durable-event", runId: "durable-run" };
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    await repo.getOrCreate(episode);
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const resolution = await pool.query<{ id: string }>('INSERT INTO "ManualRecoveryResolution" ("id", "expiredEventId", "bankCode", "runId", "outcome", "reason", "operatorId") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "id"', ["durable-resolution-id", episode.expiredEventId, episode.bankCode, episode.runId, "resolved_no_retry", "closed_without_retry", "admin-durable"]);
      await pool.query('INSERT INTO "ManualRecoveryResolutionAuditOutbox" ("id", "resolutionId") VALUES ($1, $2)', ["durable-outbox-id", resolution.rows[0]!.id]);
      await expect(repo.close(episode)).resolves.toBe("closed");
      await expect(pool.query('SELECT COUNT(*)::int AS "count" FROM "ManualRecoveryResolutionAuditOutbox" WHERE "resolutionId" = $1', [resolution.rows[0]!.id]))
        .resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await pool.end();
    }
  });

  it("enforces replay tuples, safe decisions, nonblank distinct IDs, and partial uniqueness", async () => {
    if (!TEST_DB_URL) throw new Error("RD_SYNC_TEST_DATABASE_URL is required");
    const pool = new Pool({ connectionString: TEST_DB_URL });
    const insert = (id: string, event: string, run: string, replayEvent: string | null, replayRun: string | null, replayAt: Date | null, outcome = "safe_to_retry", reason = "verified_no_mutation") =>
      pool.query('INSERT INTO "ManualRecoveryResolution" ("id", "expiredEventId", "bankCode", "runId", "outcome", "reason", "operatorId", "replayExpiredEventId", "replayRunId", "replayAuthorizedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [id, event, `bank-${id}`, run, outcome, reason, "admin-replay", replayEvent, replayRun, replayAt]);
    const authorizedAt = new Date("2026-07-28T21:30:00.000Z");
    try {
      await expect(insert("replay-valid", "original-event", "original-run", "replay-event", "replay-run", authorizedAt)).resolves.toMatchObject({ rowCount: 1 });
      await expect(insert("replay-partial", "event-2", "run-2", "replay-event-2", null, null)).rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolution_replayTuple_check" });
      await expect(insert("replay-unsafe", "event-3", "run-3", "replay-event-3", "replay-run-3", authorizedAt, "resolved_no_retry", "closed_without_retry")).rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolution_replayDecision_check" });
      await expect(insert("replay-blank", "event-4", "run-4", " ", "replay-run-4", authorizedAt)).rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolution_replayId_check" });
      await expect(insert("replay-equal", "event-5", "run-5", "event-5", "run-5", authorizedAt)).rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolution_replayId_check" });
      await expect(insert("replay-event-conflict", "event-6", "run-6", "replay-event", "replay-run-6", authorizedAt)).rejects.toMatchObject({ code: "23505", constraint: "ManualRecoveryResolution_replayExpiredEventId_key" });
      await expect(insert("replay-run-conflict", "event-7", "run-7", "replay-event-7", "replay-run", authorizedAt)).rejects.toMatchObject({ code: "23505", constraint: "ManualRecoveryResolution_replayRunId_key" });
    } finally {
      await pool.end();
    }
  });
});

describe.skipIf(!hasTestDb)("Prisma replay authorization contract (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  beforeEach(truncateTables); afterEach(truncateTables);
  async function fixture(options: { state?: "delivered" | "pending" | "delivering"; current?: "original" | "absent" | "newer" | "wrong"; safe?: boolean } = {}) {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const original = { bankCode: `replay-${crypto.randomUUID()}`, expiredEventId: `original-${crypto.randomUUID()}`, runId: `original-run-${crypto.randomUUID()}`, token: "replay-token" };
    await repo.getOrCreate(original); await repo.claimPublication(original, original.token); await repo.markPublicationPublished(original, original.token);
    await repo.claimConsumerAttempt(original, "consumer"); await repo.markConsumerMutationStarted(original, "consumer"); await repo.markConsumerManualRecoveryRequired(original, "consumer");
    const resolution = await repo.resolveConsumerManualRecovery(original, "consumer", { operatorId: "admin-replay", decision: options.safe === false ? { outcome: "resolved_no_retry", reason: "closed_without_retry" } : { outcome: "safe_to_retry", reason: "verified_no_mutation" } });
    if (!resolution) throw new Error("fixture resolution failed");
    const state = options.state ?? "delivered";
    await prisma.$executeRaw`UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = ${state}, "leaseOwner" = ${state === "delivering" ? "delivery-worker" : null}, "leaseExpiresAt" = ${state === "delivering" ? new Date("2026-07-28T12:05:00.000Z") : null}, "deliveredAt" = ${state === "delivered" ? new Date("2026-07-28T12:00:00.000Z") : null} WHERE "resolutionId" = ${resolution.id}`;
    if (options.current === "absent" || options.current === "newer") await repo.close(original);
    if (options.current === "newer") await repo.getOrCreate({ ...original, expiredEventId: `newer-${crypto.randomUUID()}`, runId: `newer-run-${crypto.randomUUID()}` });
    if (options.current === "wrong") await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "publicationState" = 'publishing' WHERE "bankCode" = ${original.bankCode}`;
    const authorize = createManualRecoveryReplayAuthorization({ repository: repo, createExpiredEventId: () => "replay-event", createRunId: () => "replay-run", clock: () => new Date("2026-07-28T12:01:00.000Z") });
    return { repo, original, resolution, authorize };
  }

  it.each(["original", "absent"] as const)("authorizes an %s original with one token-free audit and clean pending episode", async (current) => {
    const { repo, resolution, authorize } = await fixture({ current });
    await expect(authorize.authorize(resolution.id)).resolves.toMatchObject({ status: "authorized", audit: { id: `bank-autologin-replay-authorized:${resolution.id}`, actorId: "admin-replay", action: "bank_autologin.replay_authorized", metadata: { replayExpiredEventId: "replay-event", replayRunId: "replay-run" } } });
    await expect(repo.findByBankCode(resolution.bankCode)).resolves.toMatchObject({ expiredEventId: "replay-event", runId: "replay-run", publicationState: "pending", publicationClaimToken: null, publicationFailureReportedAt: null, consumerClaimToken: null, consumerAttemptState: null, expiredAuditDelivered: false, restoredAuditDelivered: false });
    await expect(prisma!.auditEvent.count()).resolves.toBe(1);
  });

  it.each([{ state: "pending" }, { state: "delivering" }, { safe: false }, { current: "newer" }, { current: "wrong" }] as const)("blocks persisted precondition failures without writes", async (options) => {
    const { repo, original, resolution, authorize } = await fixture(options);
    await expect(authorize.authorize(resolution.id)).resolves.toEqual({ status: "ineligible" });
    await expect(prisma!.auditEvent.count()).resolves.toBe(0);
    await expect(repo.findByBankCode(original.bankCode)).resolves.toMatchObject(options.current === "newer" ? { expiredEventId: expect.stringMatching(/^newer-/) } : { bankCode: original.bankCode, expiredEventId: original.expiredEventId, runId: original.runId });
  });

  it("rolls back invalid/conflicting IDs and an audit failure", async () => {
    if (!TEST_DB_URL) throw new Error("RD_SYNC_TEST_DATABASE_URL is required");
    const { repo, original, resolution, authorize } = await fixture();
    for (const [event, run] of [["", "replay-run"], [original.expiredEventId, "replay-run"], ["same", "same"]]) await expect(createManualRecoveryReplayAuthorization({ repository: repo, createExpiredEventId: () => event, createRunId: () => run }).authorize(resolution.id)).rejects.toThrow();
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      await pool.query('CREATE FUNCTION "fail_replay_audit"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'audit failed\'; END; $$'); await pool.query('CREATE TRIGGER "fail_replay_audit" BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION "fail_replay_audit"()');
      await expect(authorize.authorize(resolution.id)).rejects.toThrow();
      await expect(repo.findByBankCode(original.bankCode)).resolves.toMatchObject({ bankCode: original.bankCode, expiredEventId: original.expiredEventId, runId: original.runId });
      await expect(prisma!.manualRecoveryResolution.findUnique({ where: { id: resolution.id } })).resolves.toMatchObject({ replayExpiredEventId: null, replayRunId: null, replayAuthorizedAt: null });
      await pool.query('DROP TRIGGER "fail_replay_audit" ON "AuditEvent"'); await pool.query('DROP FUNCTION "fail_replay_audit"()');
    } finally { await pool.end(); }
  });

  it("linearizes two authorizers into one replay episode and audit", async () => {
    const { resolution, authorize } = await fixture();
    const results = await Promise.all([authorize.authorize(resolution.id), authorize.authorize(resolution.id)]);
    expect(results.map(({ status }) => status).sort()).toEqual(["already_authorized", "authorized"]);
    await expect(prisma!.bankSessionExpiryEpisode.count({ where: { bankCode: resolution.bankCode, expiredEventId: "replay-event" } })).resolves.toBe(1);
    await expect(prisma!.auditEvent.count()).resolves.toBe(1);
  });

  it("does not overwrite a competing legitimate replacement episode", async () => {
    const { repo, original, resolution, authorize } = await fixture();
    const holder = await openPausedPostgresConnection(); const observer = await openPausedPostgresConnection();
    try {
      await holder.client.query('SELECT "bankCode" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1 FOR UPDATE', [original.bankCode]);
      const contender = authorize.authorize(resolution.id);
      expect(await waitForLockWait(observer, holder.pid)).not.toBe(holder.pid);
      await holder.client.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [original.bankCode]);
      await holder.client.query('INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "updatedAt") VALUES ($1, $2, $3, NOW())', [original.bankCode, "monitor-event", "monitor-run"]);
      await holder.client.query("COMMIT");
      await expect(contender).resolves.toEqual({ status: "ineligible" });
      await expect(repo.findByBankCode(original.bankCode)).resolves.toMatchObject({ expiredEventId: "monitor-event", runId: "monitor-run" });
    } finally { await closePausedPostgresConnection(observer); await closePausedPostgresConnection(holder); }
  });
});
describe.skipIf(!hasTestDb)("Prisma atomic auto-login contract (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  beforeEach(truncateTables);
  afterEach(truncateTables);

  it("rolls back the config write when its in-transaction audit writer fails", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const bankCode = "atomic-auto-login-contract-rollback";
    await prisma.bank.create({ data: { code: bankCode, name: "Atomic Auto Login Contract" } });
    await prisma.bankAutoLoginConfig.create({ data: { bankCode, autoLoginEnabled: false } });
    const command = createSetAutoLoginEnabledAndAudit({
      prisma,
      auditWriter: async () => { throw new Error("audit write failed"); },
    });

    await expect(command({ bankCode, enabled: true, adminId: "admin-atomic-contract" })).rejects.toThrow("audit write failed");
    await expect(prisma.bankAutoLoginConfig.findUnique({ where: { bankCode } })).resolves.toMatchObject({ autoLoginEnabled: false });
    await expect(prisma.auditEvent.count({ where: { targetId: bankCode } })).resolves.toBe(0);
  });

  // A fresh install has a Bank row but no BankAutoLoginConfig row — nothing
  // provisions one. This is the exact state that made the admin toggle return
  // 404 forever in production; the previous fake-Prisma unit tests could not
  // catch it because they pre-seeded the row.
  it("provisions the config row on first enable when the bank has never been configured", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const bankCode = "auto-login-provisioning-contract";
    await prisma.bank.create({ data: { code: bankCode, name: "Auto Login Provisioning Contract" } });
    await expect(prisma.bankAutoLoginConfig.findUnique({ where: { bankCode } })).resolves.toBeNull();

    const repo = new BankAutoLoginConfigRepository(prisma);

    await expect(repo.setAutoLoginEnabled(bankCode, true, "admin-provisioning")).resolves.toMatchObject({
      bankCode,
      autoLoginEnabled: true,
      breakerState: "closed",
      breakerFailureCount: 0,
      updatedBy: "admin-provisioning",
    });
    await expect(prisma.bankAutoLoginConfig.findUnique({ where: { bankCode } })).resolves.toMatchObject({ autoLoginEnabled: true });

    // Idempotent: a second call updates the same row instead of failing.
    await expect(repo.setAutoLoginEnabled(bankCode, false, "admin-provisioning")).resolves.toMatchObject({ autoLoginEnabled: false });
    await expect(prisma.bankAutoLoginConfig.count({ where: { bankCode } })).resolves.toBe(1);
  });

  it("still fails closed for a bank that does not exist, creating no row", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const repo = new BankAutoLoginConfigRepository(prisma);

    await expect(repo.setAutoLoginEnabled("bank-that-does-not-exist", true, "admin-provisioning")).resolves.toBeNull();
    await expect(prisma.bankAutoLoginConfig.count({ where: { bankCode: "bank-that-does-not-exist" } })).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prisma audit sink contract
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("Prisma audit sink (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  beforeEach(truncateTables);
  afterEach(truncateTables);

  runAuditRepositoryContract(async () => ({
    sink: new PrismaAuditSink(),
    cleanup: truncateTables,
  }));

  it("stores one audit row for repeated deterministic delivery ids", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const sink = new PrismaAuditSink();
    const event = {
      id: "audit-delivery-contract-1",
      actorId: "system:test",
      actorRole: "system",
      action: "bank_session.expired",
      target: "bank_session",
      targetId: null,
      metadata: { sentinel: "opaque-audit-contract" },
      createdAt: new Date("2026-07-12T00:00:00.000Z"),
    };
    await sink.record(event);
    await sink.record(event);
    await expect(prisma.auditEvent.count({ where: { id: event.id } })).resolves.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Prisma user repository contract
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("Prisma user repository (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  runUserRepositoryContract(async () => {
    if (!prisma) throw new Error("prisma not initialized");

    // Ensure base roles exist (idempotent upsert).
    const adminRole = await prisma.role.upsert({
      where: { key: RoleKey.ADMIN },
      create: { key: RoleKey.ADMIN, name: "Admin", description: "Administrator" },
      update: {},
    });
    const reviewerRole = await prisma.role.upsert({
      where: { key: RoleKey.REVIEWER },
      create: { key: RoleKey.REVIEWER, name: "Reviewer", description: "Reviewer" },
      update: {},
    });

    // alice — admin role only
    await prisma.user.create({
      data: {
        id: "u-alice",
        email: "alice@example.com",
        displayName: "Alice",
        passwordHash: "hash1",
        roles: { create: { roleId: adminRole.id } },
      },
    });

    // reviewer — reviewer + viewer roles (highest = reviewer)
    // Note: viewer role not in DB for this seed; reviewer alone is sufficient for the test.
    await prisma.user.create({
      data: {
        id: "u-reviewer",
        email: "reviewer@example.com",
        displayName: "Reviewer",
        passwordHash: null,
        roles: { create: { roleId: reviewerRole.id } },
      },
    });

    // admin — admin + reviewer roles (highest = admin)
    await prisma.user.create({
      data: {
        id: "u-admin",
        email: "admin@example.com",
        displayName: "Admin",
        passwordHash: "hash3",
        roles: {
          create: [
            { roleId: adminRole.id },
            { roleId: reviewerRole.id },
          ],
        },
      },
    });

    // norole — no roles assigned (highest = viewer default)
    await prisma.user.create({
      data: {
        id: "u-norole",
        email: "norole@example.com",
        displayName: "NoRole",
        passwordHash: null,
      },
    });

    return {
      repo: new PrismaUserRepository(),
      cleanup: truncateTables,
    };
  });
});

// ---------------------------------------------------------------------------
// Smoke test — always runs — confirms skip guard is respected when DB absent.
// ---------------------------------------------------------------------------

it("Prisma contract tests are skipped when RD_SYNC_TEST_DATABASE_URL is unset", () => {
  if (!hasTestDb) {
    expect(TEST_DB_URL).toBeUndefined();
  } else {
    expect(TEST_DB_URL).toBeDefined();
  }
});

describe.skipIf(!hasTestDb)("Prisma manual recovery audit delivery (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  beforeEach(truncateTables); afterEach(truncateTables);
  async function seed(suffix: string) {
    if (!prisma) throw new Error("prisma not initialized");
    const resolution = await prisma.manualRecoveryResolution.create({ data: { id: `resolution-${suffix}`, expiredEventId: `event-${suffix}`, bankCode: `bank-${suffix}`, runId: `run-${suffix}`, outcome: "resolved_no_retry", reason: "closed_without_retry", operatorId: "admin-audit" } });
    return prisma.manualRecoveryResolutionAuditOutbox.create({ data: { id: `outbox-${suffix}`, resolutionId: resolution.id } });
  }

  it("declares atomic delivery state constraints", async () => {
    if (!prisma || !TEST_DB_URL) throw new Error("prisma not initialized");
    const outbox = await seed("tuple"); const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      for (const tuple of [["pending", "owner", null, null], ["delivering", null, new Date(), null], ["delivered", null, null, null], ["delivered", "owner", null, new Date()]] as const)
        await expect(pool.query('UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = $1, "leaseOwner" = $2, "leaseExpiresAt" = $3, "deliveredAt" = $4 WHERE "id" = $5', [...tuple, outbox.id])).rejects.toMatchObject({ code: POSTGRES_CHECK_VIOLATION, constraint: "ManualRecoveryResolutionAuditOutbox_deliveryState_check" });
      await expect(pool.query('UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = $1, "leaseOwner" = $2, "leaseExpiresAt" = NOW(), "deliveredAt" = NULL WHERE "id" = $3', ["delivering", "owner", outbox.id])).resolves.toMatchObject({ rowCount: 1 });
      const migration = await readFile(auditDeliveryMigrationPath, "utf8");
      expect(migration.trimStart()).toMatch(/^BEGIN;/); expect(migration.trimEnd()).toMatch(/COMMIT;$/); expect(migration).toContain("ManualRecoveryResolutionAuditOutbox_deliveryState_check");
    } finally { await pool.end(); }
  });

  it("elects one overlapping claimant and protects a new owner after lease expiry", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const outbox = await seed("race"); const first = new PrismaManualRecoveryResolutionAuditOutboxRepository(prisma); const second = new PrismaManualRecoveryResolutionAuditOutboxRepository(prisma);
    expect((await Promise.all([first.claim(outbox.id, "owner-a", 10000), second.claim(outbox.id, "owner-b", 10000)])).filter(Boolean)).toHaveLength(1);
    await prisma.$executeRaw`UPDATE "ManualRecoveryResolutionAuditOutbox" SET "leaseExpiresAt" = NOW() - INTERVAL '1 millisecond' WHERE "id" = ${outbox.id}`;
    await expect(second.claim(outbox.id, "owner-b", 10000)).resolves.toBe(true);
    await expect(first.markDelivered(outbox.id, "owner-a")).resolves.toBe(false); await expect(first.releaseClaim(outbox.id, "owner-a")).resolves.toBe(false);
    await expect(second.markDelivered(outbox.id, "owner-b")).resolves.toBe(true);
  });

  it("recovers acknowledgement loss with one AuditEvent after episode deletion", async () => {
    if (!prisma) throw new Error("prisma not initialized");
    const outbox = await seed("ack"); await prisma.bankSessionExpiryEpisode.create({ data: { bankCode: "bank-ack", expiredEventId: "event-ack", runId: "run-ack" } }); await prisma.bankSessionExpiryEpisode.delete({ where: { bankCode: "bank-ack" } });
    const repo = new PrismaManualRecoveryResolutionAuditOutboxRepository(prisma); const sink = new PrismaAuditSink();
    await expect(deliverManualRecoveryResolutionAudit({ findClaimable: () => repo.findClaimable(), claim: (id, owner, lease) => repo.claim(id, owner, lease), markDelivered: async () => false, releaseClaim: (id, owner) => repo.releaseClaim(id, owner), inspect: (id) => repo.inspect(id) }, sink, "owner-a", 10000)).rejects.toThrow("acknowledgement lost");
    await prisma.$executeRaw`UPDATE "ManualRecoveryResolutionAuditOutbox" SET "leaseExpiresAt" = NOW() - INTERVAL '1 millisecond' WHERE "id" = ${outbox.id}`;
    await expect(deliverManualRecoveryResolutionAudit(repo, sink, "owner-b", 10000)).resolves.toBe(true);
    await expect(prisma.auditEvent.count({ where: { id: "bank-autologin-manual-recovery-resolved:resolution-ack" } })).resolves.toBe(1);
  });
});
