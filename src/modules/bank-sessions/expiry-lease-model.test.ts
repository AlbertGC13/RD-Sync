import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  InMemoryBankSessionExpiryEpisodeRepository,
  parseConsumerAttemptLease,
} from "./expiry-episodes";

const leaseMigrationPath = fileURLToPath(
  new URL("../../../prisma/migrations/20260807000000_add_expiry_consumer_lease_model/migration.sql", import.meta.url),
);
const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));

describe("Expiry consumer lease model", () => {
  const activeLease = new Date("2026-08-07T12:00:00.000Z");

  it.each([
    ["scheduled", activeLease, "mutation_started", "published"],
    ["scrape_time", activeLease, "mutation_started", "pending"],
  ] as const)("represents a valid %s consumer attempt", (source, leaseExpiresAt, attemptState, publicationState) => {
    expect(parseConsumerAttemptLease(source, leaseExpiresAt, attemptState, publicationState, null)).toEqual({
      source,
      leaseExpiresAt,
    });
  });

  it.each([
    [null, activeLease, "reserved", "published", null],
    ["scheduled", null, null, "published", null],
    ["scheduled", null, "reserved", "published", null],
    ["unknown", activeLease, "reserved", "published", null],
    ["scrape_time", activeLease, "mutation_started", "published", null],
    ["scheduled", activeLease, "mutation_started", "pending", null],
    ["scheduled", activeLease, "resolved", "published", null],
    ["scrape_time", activeLease, "manual_recovery_required", "pending", null],
    ["scheduled", activeLease, "reserved", "published", "job_missing"],
  ] as const)("rejects an incoherent source/lease tuple", (source, leaseExpiresAt, attemptState, publicationState, terminalFailureReason) => {
    expect(() => parseConsumerAttemptLease(source, leaseExpiresAt, attemptState, publicationState, terminalFailureReason)).toThrow("Invalid consumer lease tuple");
  });

  it("keeps legacy attempts valid and creates dormant lease fields in memory", async () => {
    expect(parseConsumerAttemptLease(null, null, "mutation_started", "published", null)).toEqual({
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
