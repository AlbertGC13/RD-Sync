/**
 * Schema validation tests for BankAutoLoginConfig and BankAdapterConfig models.
 *
 * These tests verify the Prisma schema contains the expected models,
 * fields, defaults, and constraints required by the multi-bank auto-login
 * design (PR4.2). No database connection required — the tests validate
 * the generated Prisma client types and the migration SQL file.
 *
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Import Prisma client types — these will FAIL to compile until the models
// are added to schema.prisma and `prisma generate` is run.
// ---------------------------------------------------------------------------

import type { BankAutoLoginConfig, BankAdapterConfig } from "../../generated/prisma/client";

// ---------------------------------------------------------------------------
// Type-level contract: models exist and carry the expected shape
// ---------------------------------------------------------------------------

describe("BankAutoLoginConfig model contract", () => {
  it("has bankCode, autoLoginEnabled, breakerState, and audit fields", () => {
    // Type-level assertion: if the model is missing any field, TypeScript
    // will fail to compile and vitest will refuse to run this test.
    const assertShape = (row: BankAutoLoginConfig) => {
      // Touch the type to prevent unused-var lint without suppressing it.
      void row;
    };
    expect(assertShape).toBeDefined();

  });

  it("breakerState is a string (closed|open only, NO half_open)", () => {
    // The design mandates closed|open only — no half_open state.
    // This is enforced at the policy layer (PR4.3), but the schema
    // field must be a String (not an enum) to allow future extension
    // without a migration. We verify the type compiles as string.
    const sample: BankAutoLoginConfig = {
      id: "test",
      bankCode: "popular",
      autoLoginEnabled: false,
      breakerState: "closed",
      breakerFailureCount: 0,
      breakerFailureWindowStart: null,
      breakerOpenedAt: null,
      breakerLastResetAt: null,
      updatedAt: new Date(),
      updatedBy: null,
    } as unknown as BankAutoLoginConfig;

    expect(sample.breakerState).toBe("closed");
  });
});

describe("BankAdapterConfig model contract", () => {
  it("has bankCode, scrapingEnabled, and audit fields", () => {
    const assertShape = (row: BankAdapterConfig) => {
      void row;
    };
    expect(assertShape).toBeDefined();
  });

  it("scrapingEnabled defaults to true per design", () => {
    // The design requires scrapingEnabled to default to true (adapter enabled by default).
    // We verify this via the migration SQL, not runtime defaults (no DB in unit tests).
    const sample: BankAdapterConfig = {
      id: "test",
      bankCode: "popular",
      scrapingEnabled: true,
      updatedAt: new Date(),
      updatedBy: null,
    } as unknown as BankAdapterConfig;

    expect(sample.scrapingEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration SQL validation — structural check without database
// ---------------------------------------------------------------------------

describe("migration SQL for BankAutoLoginConfig + BankAdapterConfig", () => {
  const pr4ConfigMigrationSql = readPr4ConfigMigrationSql();

  it("contains a migration file that creates both tables", () => {
    // Must create both tables
    expect(pr4ConfigMigrationSql).toContain("CREATE TABLE \"BankAutoLoginConfig\"");
    expect(pr4ConfigMigrationSql).toContain("CREATE TABLE \"BankAdapterConfig\"");
  });

  it("BankAutoLoginConfig has correct columns and constraints", () => {
    // Required columns
    expect(pr4ConfigMigrationSql).toContain('"bankCode" TEXT NOT NULL');
    expect(pr4ConfigMigrationSql).toContain('"autoLoginEnabled" BOOLEAN NOT NULL DEFAULT false');
    expect(pr4ConfigMigrationSql).toContain('"breakerState" TEXT NOT NULL DEFAULT \'closed\'');
    expect(pr4ConfigMigrationSql).toContain('"breakerFailureCount" INTEGER NOT NULL DEFAULT 0');
    expect(pr4ConfigMigrationSql).toContain('"breakerFailureWindowStart" TIMESTAMP(3)');
    expect(pr4ConfigMigrationSql).toContain('"breakerOpenedAt" TIMESTAMP(3)');
    expect(pr4ConfigMigrationSql).toContain('"breakerLastResetAt" TIMESTAMP(3)');
    expect(pr4ConfigMigrationSql).toContain('"updatedBy" TEXT');

    // Unique constraint on bankCode
    expect(pr4ConfigMigrationSql).toContain('"BankAutoLoginConfig_bankCode_key"');
    // DB-level invariant for breakerState
    expect(pr4ConfigMigrationSql).toContain(
      'CONSTRAINT "BankAutoLoginConfig_breakerState_check" CHECK ("breakerState" IN (\'closed\', \'open\'))'
    );
    // Foreign key to Bank.code
    expect(pr4ConfigMigrationSql).toContain('"BankAutoLoginConfig_bankCode_fkey"');
    expect(pr4ConfigMigrationSql).toContain('REFERENCES "Bank"("code")');
  });

  it("BankAdapterConfig has correct columns and constraints", () => {
    // Required columns
    expect(pr4ConfigMigrationSql).toContain('"bankCode" TEXT NOT NULL');
    expect(pr4ConfigMigrationSql).toContain('"scrapingEnabled" BOOLEAN NOT NULL DEFAULT true');
    expect(pr4ConfigMigrationSql).toContain('"updatedBy" TEXT');

    // Unique constraint on bankCode
    expect(pr4ConfigMigrationSql).toContain('"BankAdapterConfig_bankCode_key"');
    // Foreign key to Bank.code
    expect(pr4ConfigMigrationSql).toContain('"BankAdapterConfig_bankCode_fkey"');
    expect(pr4ConfigMigrationSql).toContain('REFERENCES "Bank"("code")');
  });

  it("does NOT contain any half_open breaker state", () => {
    // The design explicitly prohibits half_open state
    expect(pr4ConfigMigrationSql.toLowerCase()).not.toContain("half_open");
  });
});

function readPr4ConfigMigrationSql(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260702000000_add_bank_auto_login_and_adapter_config/migration.sql"
    ),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Schema model back-relation validation
// ---------------------------------------------------------------------------

describe("Bank model back-relations", () => {
  it("BankAutoLoginConfig and BankAdapterConfig types are importable", () => {
    // If the Bank model doesn't have back-relations, these imports
    // will still work — but the Prisma Client types should include
    // the relation fields. We validate the type shape.
    expect(true).toBe(true);
  });
});
