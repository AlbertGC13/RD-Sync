import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  InMemoryBankSessionExpiryEpisodeRepository,
  parseConsumerAttemptLease,
} from "./expiry-episodes";
import { createLeaseExpiresAt, INVALID_CONSUMER_LEASE_TUPLES } from "./expiry-lease-model.test-support";

const leaseMigrationPath = fileURLToPath(
  new URL("../../../prisma/migrations/20260807000000_add_expiry_consumer_lease_model/migration.sql", import.meta.url),
);
const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));

describe("Expiry consumer lease model", () => {
  const activeLease = new Date("2026-08-07T12:00:00.000Z");

  it.each([
    ["scheduled", activeLease, "mutation_started", "published", "publication-token"],
    ["scrape_time", activeLease, "mutation_started", "pending", null],
  ] as const)("represents a valid %s consumer attempt", (source, leaseExpiresAt, attemptState, publicationState, publicationClaimToken) => {
    expect(parseConsumerAttemptLease(source, leaseExpiresAt, attemptState, publicationState, publicationClaimToken, null)).toEqual({
      source,
      leaseExpiresAt,
    });
  });

  it.each(INVALID_CONSUMER_LEASE_TUPLES)("rejects $name", (tuple) => {
    expect(() => parseConsumerAttemptLease(tuple.source, createLeaseExpiresAt(tuple.leaseExpiresAt), tuple.attemptState, tuple.publicationState, tuple.publicationClaimToken, tuple.terminalFailureReason)).toThrow("Invalid consumer lease tuple");
  });

  it("keeps legacy attempts valid and creates dormant lease fields in memory", async () => {
    expect(parseConsumerAttemptLease(null, null, "mutation_started", "published", "publication-token", null)).toEqual({
      source: null,
      leaseExpiresAt: null,
    });
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();

    await expect(episodes.getOrCreate({ bankCode: "lease-model", expiredEventId: "event", runId: "run" })).resolves.toMatchObject({
      episode: { consumerAttemptSource: null, consumerLeaseExpiresAt: null },
    });
  });

  it("declares additive nullable source and lease columns in the committed schema and migration", async () => {
    const [schema, migration] = await Promise.all([readFile(schemaPath, "utf8"), readFile(leaseMigrationPath, "utf8")]);

    expect(schema).toMatch(/consumerAttemptSource\s+String\?/);
    expect(schema).toMatch(/consumerLeaseExpiresAt\s+DateTime\?/);
    expect(migration).toContain('CONSTRAINT "BankSessionExpiryEpisode_consumerLease_check" CHECK');
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("claims scheduled and scrape-time leases with their distinct CAS envelopes", async () => {
    let now = new Date("2026-08-07T12:00:00.000Z");
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(() => now);
    const scheduled = { bankCode: "scheduled-lease", expiredEventId: "event", runId: "run", token: "publication-token" };
    const scrape = { bankCode: "scrape-lease", expiredEventId: "event", runId: "run" };
    await episodes.getOrCreate(scheduled); await episodes.claimPublication(scheduled, scheduled.token); await episodes.markPublicationPublished(scheduled, scheduled.token);
    await episodes.getOrCreate(scrape);

    await expect(episodes.claimConsumerAttemptLease({ source: "scheduled", envelope: scheduled, consumerClaimToken: "scheduled-owner", leaseDurationMs: 500 })).resolves.toBe(true);
    await expect(episodes.claimConsumerAttemptLease({ source: "scrape_time", episode: scrape, consumerClaimToken: "scrape-owner", leaseDurationMs: 500 })).resolves.toBe(true);
    await expect(episodes.claimPublication(scrape, "publisher")).resolves.toBe(false);
    await expect(episodes.findByBankCode(scheduled.bankCode)).resolves.toMatchObject({ consumerAttemptSource: "scheduled", consumerLeaseExpiresAt: new Date(now.getTime() + 500) });
    now = new Date(now.getTime() + 500);
    await expect(episodes.renewConsumerAttemptLease({ source: "scheduled", envelope: scheduled, consumerClaimToken: "scheduled-owner", leaseDurationMs: 500 })).resolves.toBe(false);
  });

  it("renews only an active exact owner and expires stale leased transitions", async () => {
    let now = new Date("2026-08-07T12:00:00.000Z");
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(() => now);
    const envelope = { bankCode: "renew-lease", expiredEventId: "event", runId: "run", token: "publication-token" };
    await episodes.getOrCreate(envelope); await episodes.claimPublication(envelope, envelope.token); await episodes.markPublicationPublished(envelope, envelope.token);
    const claim = { source: "scheduled" as const, envelope, consumerClaimToken: "owner", leaseDurationMs: 100 };
    await episodes.claimConsumerAttemptLease(claim);
    await expect(episodes.renewConsumerAttemptLease({ ...claim, consumerClaimToken: "other" })).resolves.toBe(false);
    await expect(episodes.renewConsumerAttemptLease(claim)).resolves.toBe(true);
    now = new Date(now.getTime() + 100);
    await expect(episodes.markConsumerMutationStarted(envelope, "owner")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryRequired(envelope, "owner")).resolves.toBe(false);
    await expect(episodes.markConsumerResolved(envelope, "owner")).resolves.toBe(false);
  });

  it("keeps legacy transitions and clears a leased reservation when restoration is delivered", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const legacy = { bankCode: "legacy-transition", expiredEventId: "event", runId: "run", token: "publication-token" };
    await episodes.getOrCreate(legacy); await episodes.claimPublication(legacy, legacy.token); await episodes.markPublicationPublished(legacy, legacy.token); await episodes.claimConsumerAttempt(legacy, "owner");
    await expect(episodes.markConsumerMutationStarted(legacy, "owner")).resolves.toBe(true);
    const leased = { ...legacy, bankCode: "leased-restoration" };
    await episodes.getOrCreate(leased); await episodes.claimPublication(leased, leased.token); await episodes.markPublicationPublished(leased, leased.token);
    await episodes.claimConsumerAttemptLease({ source: "scheduled", envelope: leased, consumerClaimToken: "owner", leaseDurationMs: 100 });
    await episodes.markAuditDelivered(leased, "restored");
    await expect(episodes.findByBankCode(leased.bankCode)).resolves.toMatchObject({ consumerClaimToken: null, consumerAttemptState: null, consumerAttemptSource: null, consumerLeaseExpiresAt: null });
  });
});
