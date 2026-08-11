import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createLeaseExpiresAt, INVALID_CONSUMER_LEASE_TUPLES } from "../bank-sessions/expiry-lease-model.test-support";
import type { ConsumerAttemptLeaseOwner } from "../bank-sessions/expiry-episodes";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaBankSessionExpiryEpisodeRepository } from "./prisma-bank-session-expiry-episode-repository";

const testDatabaseUrl = process.env.RD_SYNC_TEST_DATABASE_URL;
const hasTestDatabase = Boolean(testDatabaseUrl);
const constraint = "BankSessionExpiryEpisode_consumerLease_check";
const activeLease = new Date("2026-08-07T12:00:00.000Z");
const pool = hasTestDatabase ? new Pool({ connectionString: testDatabaseUrl }) : undefined;
const prisma = hasTestDatabase ? new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl! }) }) : undefined;

describe.skipIf(!hasTestDatabase)("Expiry consumer lease PostgreSQL contract", () => {
  beforeEach(async () => {
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" LIKE \'lease-contract-%\'');
  });

  afterAll(async () => {
    await pool?.end();
    await prisma?.$disconnect();
  });

  async function insert(bankCode: string): Promise<void> {
    await pool!.query('INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "updatedAt") VALUES ($1, $2, $3, NOW())', [bankCode, `${bankCode}-event`, `${bankCode}-run`]);
  }

  async function setTuple(bankCode: string, source: string | null, leaseExpiresAt: Date | null, state: string | null, publicationState: string, publicationClaimToken: string | null = publicationState === "published" ? "publication-token" : null, terminalFailureReason: string | null = null): Promise<void> {
    await pool!.query('UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = CASE WHEN $1::text IS NULL THEN NULL ELSE \'consumer-token\' END, "consumerAttemptState" = $1::text, "consumerAttemptSource" = $2, "consumerLeaseExpiresAt" = $3, "publicationState" = $4, "publicationClaimToken" = $5::text, "terminalFailureReason" = $6::text, "terminalFailureReconciledAt" = CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END WHERE "bankCode" = $7', [state, source, leaseExpiresAt, publicationState, publicationClaimToken, terminalFailureReason, bankCode]);
  }

  it("accepts scheduled and scrape-time ownership while retaining the legacy null tuple", async () => {
    await insert("lease-contract-scheduled");
    await setTuple("lease-contract-scheduled", "scheduled", activeLease, "mutation_started", "published");
    await insert("lease-contract-scrape");
    await setTuple("lease-contract-scrape", "scrape_time", activeLease, "mutation_started", "pending");
    await insert("lease-contract-legacy");
    await setTuple("lease-contract-legacy", null, null, "mutation_started", "published");
  });

  it.each(INVALID_CONSUMER_LEASE_TUPLES)("rejects $name", async (tuple) => {
    const bankCode = `lease-contract-invalid-${tuple.name.replaceAll(" ", "-")}`;
    await insert(bankCode);

    await expect(setTuple(bankCode, tuple.source, createLeaseExpiresAt(tuple.leaseExpiresAt), tuple.attemptState, tuple.publicationState, tuple.publicationClaimToken, tuple.terminalFailureReason)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  });

  it.each(["scheduled", "scrape_time"] as const)("persists all lease-aware %s lifecycle transitions", async (source) => {
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma!);
    const identity = { bankCode: `lease-contract-lifecycle-${source}`, expiredEventId: "event", runId: "run" };
    const envelope = { ...identity, token: "publication-token" };
    const owner: ConsumerAttemptLeaseOwner = source === "scheduled" ? { source, envelope, consumerClaimToken: "owner" } : { source, episode: identity, consumerClaimToken: "owner" };
    await repo.getOrCreate(identity);
    if (source === "scheduled") { await repo.claimPublication(envelope, envelope.token); await repo.markPublicationPublished(envelope, envelope.token); }
    await repo.claimConsumerAttemptLease({ ...owner, leaseDurationMs: 10_000 });
    await expect(repo.markConsumerMutationStartedLease(owner)).resolves.toBe(true);
    await expect(repo.markConsumerManualRecoveryRequiredLease(owner)).resolves.toBe(true);
    await expect(repo.findByBankCode(identity.bankCode)).resolves.toMatchObject({ consumerAttemptState: "manual_recovery_required", consumerLeaseExpiresAt: null, consumerClaimToken: "owner" });

    const resolvedIdentity = { ...identity, bankCode: `${identity.bankCode}-resolved`, expiredEventId: "event-resolved", runId: "run-resolved" };
    const resolvedEnvelope = { ...resolvedIdentity, token: envelope.token };
    const resolvedOwner: ConsumerAttemptLeaseOwner = source === "scheduled" ? { source, envelope: resolvedEnvelope, consumerClaimToken: "owner" } : { source, episode: resolvedIdentity, consumerClaimToken: "owner" };
    await repo.getOrCreate(resolvedIdentity);
    if (source === "scheduled") { await repo.claimPublication(resolvedEnvelope, resolvedEnvelope.token); await repo.markPublicationPublished(resolvedEnvelope, resolvedEnvelope.token); }
    await repo.claimConsumerAttemptLease({ ...resolvedOwner, leaseDurationMs: 10_000 });
    await expect(repo.markConsumerResolvedLease(resolvedOwner)).resolves.toBe(true);
    await expect(repo.findByBankCode(resolvedIdentity.bankCode)).resolves.toMatchObject({ consumerAttemptState: "resolved", consumerLeaseExpiresAt: null });
  });

  it("rejects stale PostgreSQL lease owners after an expiry sweep", async () => {
    const repo = new PrismaBankSessionExpiryEpisodeRepository(prisma!);
    const identity = { bankCode: "lease-contract-expired", expiredEventId: "event", runId: "run" };
    const owner: ConsumerAttemptLeaseOwner = { source: "scrape_time", episode: identity, consumerClaimToken: "owner" };
    await repo.getOrCreate(identity);
    await repo.claimConsumerAttemptLease({ ...owner, leaseDurationMs: 10_000 });
    await pool!.query('UPDATE "BankSessionExpiryEpisode" SET "consumerLeaseExpiresAt" = NOW() WHERE "bankCode" = $1', [identity.bankCode]);
    const [swept, advanced] = await Promise.all([repo.reconcileExpiredConsumerAttemptLease(identity), repo.markConsumerMutationStartedLease(owner)]);
    expect([swept, advanced].filter(Boolean)).toHaveLength(1);
    await expect(repo.markConsumerResolvedLease({ ...owner, consumerClaimToken: "other" })).resolves.toBe(false);
  });
});
