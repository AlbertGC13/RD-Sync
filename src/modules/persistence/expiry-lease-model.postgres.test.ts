import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

const testDatabaseUrl = process.env.RD_SYNC_TEST_DATABASE_URL;
const hasTestDatabase = Boolean(testDatabaseUrl);
const constraint = "BankSessionExpiryEpisode_consumerLease_check";
const activeLease = new Date("2026-08-07T12:00:00.000Z");
const pool = hasTestDatabase ? new Pool({ connectionString: testDatabaseUrl }) : undefined;

describe.skipIf(!hasTestDatabase)("Expiry consumer lease PostgreSQL contract", () => {
  beforeEach(async () => {
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" LIKE \'lease-contract-%\'');
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insert(bankCode: string): Promise<void> {
    await pool!.query('INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "updatedAt") VALUES ($1, $2, $3, NOW())', [bankCode, `${bankCode}-event`, `${bankCode}-run`]);
  }

  async function setTuple(bankCode: string, source: string | null, leaseExpiresAt: Date | null, state: string | null, publicationState: string, terminalFailureReason: string | null = null): Promise<void> {
    await pool!.query('UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = CASE WHEN $1::text IS NULL THEN NULL ELSE \'consumer-token\' END, "consumerAttemptState" = $1::text, "consumerAttemptSource" = $2, "consumerLeaseExpiresAt" = $3, "publicationState" = $4, "publicationClaimToken" = CASE WHEN $4 = \'published\' THEN \'publication-token\' ELSE NULL END, "terminalFailureReason" = $5::text, "terminalFailureReconciledAt" = CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END WHERE "bankCode" = $6', [state, source, leaseExpiresAt, publicationState, terminalFailureReason, bankCode]);
  }

  it("accepts scheduled and scrape-time ownership while retaining the legacy null tuple", async () => {
    await insert("lease-contract-scheduled");
    await setTuple("lease-contract-scheduled", "scheduled", activeLease, "mutation_started", "published");
    await insert("lease-contract-scrape");
    await setTuple("lease-contract-scrape", "scrape_time", activeLease, "mutation_started", "pending");
    await insert("lease-contract-legacy");
    await setTuple("lease-contract-legacy", null, null, "mutation_started", "published");
  });

  it.each([
    ["lease without source", null, activeLease, "reserved", "published", null],
    ["source without an attempt state", "scheduled", null, null, "published", null],
    ["active source without lease", "scheduled", null, "reserved", "published", null],
    ["unknown source", "unknown", activeLease, "reserved", "published", null],
    ["scrape-time source marked published", "scrape_time", activeLease, "mutation_started", "published", null],
    ["scheduled source without canonical publication", "scheduled", activeLease, "mutation_started", "pending", null],
    ["resolved source with an active lease", "scheduled", activeLease, "resolved", "published", null],
    ["manual recovery source with an active lease", "scrape_time", activeLease, "manual_recovery_required", "pending", null],
    ["terminal failure source with an active lease", "scheduled", activeLease, "reserved", "published", "job_missing"],
  ] as const)("rejects %s", async (_name, source, leaseExpiresAt, state, publicationState, terminalFailureReason) => {
    const bankCode = `lease-contract-invalid-${_name.replaceAll(" ", "-")}`;
    await insert(bankCode);

    await expect(setTuple(bankCode, source, leaseExpiresAt, state, publicationState, terminalFailureReason)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  });
});
