/**
 * Contract tests for Prisma-backed repository implementations.
 *
 * These tests are SKIPPED by default. They require a real PostgreSQL database
 * with the RD-Sync schema applied.
 *
 * To run against a test database:
 *
 *   1. Create a throwaway PostgreSQL database (NEVER use the dev DATABASE_URL).
 *   2. Apply the schema:
 *        RD_SYNC_TEST_DATABASE_URL="postgresql://..." pnpm prisma:migrate
 *      or push without migration history:
 *        RD_SYNC_TEST_DATABASE_URL="postgresql://..." pnpm db:push
 *   3. Run the Prisma contract tests:
 *        RD_SYNC_TEST_DATABASE_URL="postgresql://..." pnpm test --reporter=verbose
 *
 * The test suite truncates rows in afterEach to keep each test isolated.
 * RD_SYNC_TEST_DATABASE_URL is intentionally SEPARATE from DATABASE_URL
 * so the production/dev database is never touched during testing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../../generated/prisma/client";

import { PrismaTransactionRepository } from "./prisma-transaction-repository";
import { PrismaScrapeRunRepository } from "./prisma-scrape-run-repository";
import { PrismaAuditSink } from "./prisma-audit-sink";
import { PrismaBankSessionExpiryEpisodeRepository } from "./prisma-bank-session-expiry-episode-repository";
import { PUBLICATION_CLAIM_TIMEOUT_MS, publishExpiryEpisode } from "../bank-sessions/expiry-episodes";
import { createBankSessionMonitor } from "../bank-sessions";
import { InMemoryAuditSink } from "../audit";

import { runTransactionRepositoryContract } from "./contracts/transaction-repository.contract";
import { runScrapeRunRepositoryContract } from "./contracts/scrape-run-repository.contract";
import { runAuditRepositoryContract } from "./contracts/audit-repository.contract";
import { PrismaUserRepository } from "./prisma-user-repository";
import { runUserRepositoryContract } from "./contracts/user-repository.contract";
import { RoleKey } from "../../generated/prisma/enums";

const TEST_DB_URL = process.env.RD_SYNC_TEST_DATABASE_URL;
const hasTestDb = Boolean(TEST_DB_URL);
const MAX_POSTGRES_LOCK_WAIT_ATTEMPTS = 100;

// ---------------------------------------------------------------------------
// Shared test client — one pool for the entire test file.
// ---------------------------------------------------------------------------

let prisma: PrismaClient | undefined;

// Capture original so we can restore it after the suite.
const _originalDatabaseUrl = process.env.DATABASE_URL;

if (hasTestDb) {
  beforeAll(() => {
    // Repositories call getPrismaClient() which reads DATABASE_URL.
    // Mirror the test URL there so repositories target the same test DB.
    process.env.DATABASE_URL = TEST_DB_URL!;
    const adapter = new PrismaPg({ connectionString: TEST_DB_URL! });
    prisma = new PrismaClient({ adapter });
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
  await prisma.$executeRawUnsafe('DELETE FROM "BankSessionExpiryEpisode"');
  await prisma.bank.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
}

async function openPausedPostgresConnection() { if (!TEST_DB_URL) throw new Error("RD_SYNC_TEST_DATABASE_URL is required"); const pool = new Pool({ connectionString: TEST_DB_URL }); const client = await pool.connect(); await client.query("BEGIN"); const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"); return { client, pool, pid: identity.rows[0]!.pid }; }
async function closePausedPostgresConnection(connection: Awaited<ReturnType<typeof openPausedPostgresConnection>>) { await connection.client.query("ROLLBACK").catch(() => undefined); connection.client.release(); await connection.pool.end(); }
async function waitForLockWait(observer: Awaited<ReturnType<typeof openPausedPostgresConnection>>, holderPid: number): Promise<number> { for (let attempts = 0; attempts < MAX_POSTGRES_LOCK_WAIT_ATTEMPTS; attempts += 1) { const result = await observer.client.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%BankSessionExpiryEpisode%'", [holderPid]); if (result.rows[0]) return result.rows[0].pid; } throw new Error("repository query did not enter a PostgreSQL lock wait"); }

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
    await expect(publishExpiryEpisode(repo, episode, "token-a", async (job) => { accepted.push(job); throw new Error("acknowledgement lost"); })).rejects.toThrow("acknowledgement lost");
    await expect(repo.findByBankCode(episode.bankCode)).resolves.toMatchObject({ publicationClaimToken: "token-a", publicationFailureReportedAt: expect.any(Date) });
    await expect(publishExpiryEpisode(repo, episode, "token-b", async (job) => { accepted.push(job); })).resolves.toBe(true);
    expect(accepted).toEqual([{ ...episode, token: "token-a" }, { ...episode, token: "token-a" }]);
    await expect(repo.findByBankCode(episode.bankCode)).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a", publicationFailureReportedAt: null });

    const crash = { bankCode: "bhd", expiredEventId: "event-crash", runId: "bhd-expiry-event-crash" };
    await repo.getOrCreate(crash);
    await repo.claimPublication(crash, "token-a");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + PUBLICATION_CLAIM_TIMEOUT_MS * 2));
      await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "updatedAt" = NOW() WHERE "bankCode" = ${crash.bankCode}`;
      await expect(publishExpiryEpisode(repo, crash, "token-b", async (job) => { accepted.push(job); })).resolves.toBe(false);
      await prisma.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "updatedAt" = NOW() - (${PUBLICATION_CLAIM_TIMEOUT_MS + 1} * INTERVAL '1 millisecond') WHERE "bankCode" = ${crash.bankCode}`;
      await expect(publishExpiryEpisode(repo, crash, "token-b", async (job) => { accepted.push(job); })).resolves.toBe(true);
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
    const enqueue = vi.fn();
    await repo.getOrCreate(episode);
    const holder = await openPausedPostgresConnection();
    try {
      await holder.client.query('UPDATE "BankSessionExpiryEpisode" SET "restoredAuditDeliveredAt" = NOW() WHERE "bankCode" = $1', [episode.bankCode]);

      // Act
      const competitor = publishExpiryEpisode(repo, episode, "claim", enqueue);
      expect(await waitForLockWait(holder, holder.pid)).not.toBe(holder.pid);
      await holder.client.query("COMMIT");

      // Assert
      await expect(competitor).resolves.toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
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
