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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

import { PrismaTransactionRepository } from "./prisma-transaction-repository";
import { PrismaScrapeRunRepository } from "./prisma-scrape-run-repository";
import { PrismaAuditSink } from "./prisma-audit-sink";

import { runTransactionRepositoryContract } from "./contracts/transaction-repository.contract";
import { runScrapeRunRepositoryContract } from "./contracts/scrape-run-repository.contract";
import { runAuditRepositoryContract } from "./contracts/audit-repository.contract";
import { PrismaUserRepository } from "./prisma-user-repository";
import { runUserRepositoryContract } from "./contracts/user-repository.contract";
import { RoleKey } from "../../generated/prisma/enums";

const TEST_DB_URL = process.env.RD_SYNC_TEST_DATABASE_URL;
const hasTestDb = Boolean(TEST_DB_URL);

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
  await prisma.bank.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
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

// ---------------------------------------------------------------------------
// Prisma audit sink contract
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("Prisma audit sink (requires RD_SYNC_TEST_DATABASE_URL)", () => {
  runAuditRepositoryContract(async () => ({
    sink: new PrismaAuditSink(),
    cleanup: truncateTables,
  }));
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
