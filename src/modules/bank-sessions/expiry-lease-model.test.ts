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
});
