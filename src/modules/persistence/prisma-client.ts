/**
 * Lazily-constructed, globalThis-anchored singleton PrismaClient.
 *
 * The client is created on first access using the DATABASE_URL environment
 * variable (read at access time, not at import time). Anchoring on
 * globalThis.__rdSyncPrismaClient ensures that Next.js dev module-graph
 * reloads reuse a single connection pool rather than spawning a new one per
 * hot-reload cycle — the standard Next+Prisma dev pattern.
 *
 * Importing this module is always safe even when DATABASE_URL is unset;
 * the error is thrown only when getPrismaClient() is actually called.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import type {
  TransactionDirection as PrismaTransactionDirection,
  ReviewState as PrismaReviewState,
  ScrapeRunStatus as PrismaScrapeRunStatus,
} from "../../generated/prisma/enums";

// Re-export enum types for use in repository implementations.
export type { PrismaTransactionDirection, PrismaReviewState, PrismaScrapeRunStatus };

// ---------------------------------------------------------------------------
// Singleton wiring
// ---------------------------------------------------------------------------

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncPrismaClient?: PrismaClient;
};

/**
 * Return the globalThis-anchored PrismaClient singleton.
 * Throws a clear error if DATABASE_URL is not set.
 */
export function getPrismaClient(): PrismaClient {
  if (!globalRegistry.__rdSyncPrismaClient) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. The Prisma-backed repositories require a PostgreSQL connection string.",
      );
    }

    const adapter = new PrismaPg({ connectionString });
    globalRegistry.__rdSyncPrismaClient = new PrismaClient({ adapter });
  }

  return globalRegistry.__rdSyncPrismaClient;
}

// ---------------------------------------------------------------------------
// Enum mapping helpers — domain lowercase strings <-> Prisma UPPERCASE keys
// ---------------------------------------------------------------------------
// Prisma enums use UPPERCASE keys that @map to lowercase DB values.

import { TransactionDirection, ReviewState, ScrapeRunStatus } from "../../generated/prisma/enums";

export { TransactionDirection, ReviewState, ScrapeRunStatus };

/**
 * Map domain direction string to Prisma enum key.
 */
export function toDbDirection(direction: "credit" | "debit"): PrismaTransactionDirection {
  return direction === "credit" ? TransactionDirection.CREDIT : TransactionDirection.DEBIT;
}

/**
 * Map Prisma direction enum key back to domain string.
 */
export function fromDbDirection(direction: PrismaTransactionDirection): "credit" | "debit" {
  return direction === TransactionDirection.CREDIT ? "credit" : "debit";
}

/**
 * Map domain reviewState string to Prisma ReviewState enum key.
 */
export function toDbReviewState(
  state: "new" | "seen" | "internally_validated" | "ignored" | "needs_review",
): PrismaReviewState {
  const map: Record<string, PrismaReviewState> = {
    new: ReviewState.NEW,
    seen: ReviewState.SEEN,
    internally_validated: ReviewState.INTERNALLY_VALIDATED,
    ignored: ReviewState.IGNORED,
    needs_review: ReviewState.NEEDS_REVIEW,
  };
  const result = map[state];
  if (result === undefined) throw new Error(`Unknown review state: ${state}`);
  return result;
}

/**
 * Map Prisma ReviewState enum key back to domain string.
 */
export function fromDbReviewState(
  state: PrismaReviewState,
): "new" | "seen" | "internally_validated" | "ignored" | "needs_review" {
  const map: Record<string, "new" | "seen" | "internally_validated" | "ignored" | "needs_review"> = {
    [ReviewState.NEW]: "new",
    [ReviewState.SEEN]: "seen",
    [ReviewState.INTERNALLY_VALIDATED]: "internally_validated",
    [ReviewState.IGNORED]: "ignored",
    [ReviewState.NEEDS_REVIEW]: "needs_review",
  };
  const result = map[state];
  if (result === undefined) throw new Error(`Unknown DB review state: ${state}`);
  return result;
}

/**
 * Map domain ScrapeRunStatus string to Prisma enum key.
 */
export function toDbScrapeRunStatus(
  status: "queued" | "running" | "succeeded" | "failed" | "needs_admin_action" | "throttled",
): PrismaScrapeRunStatus {
  const map: Record<string, PrismaScrapeRunStatus> = {
    queued: ScrapeRunStatus.QUEUED,
    running: ScrapeRunStatus.RUNNING,
    succeeded: ScrapeRunStatus.SUCCEEDED,
    failed: ScrapeRunStatus.FAILED,
    needs_admin_action: ScrapeRunStatus.NEEDS_ADMIN_ACTION,
    throttled: ScrapeRunStatus.THROTTLED,
  };
  const result = map[status];
  if (result === undefined) throw new Error(`Unknown scrape run status: ${status}`);
  return result;
}

/**
 * Map Prisma ScrapeRunStatus enum key back to domain string.
 */
export function fromDbScrapeRunStatus(
  status: PrismaScrapeRunStatus,
): "queued" | "running" | "succeeded" | "failed" | "needs_admin_action" | "throttled" {
  const map: Record<
    string,
    "queued" | "running" | "succeeded" | "failed" | "needs_admin_action" | "throttled"
  > = {
    [ScrapeRunStatus.QUEUED]: "queued",
    [ScrapeRunStatus.RUNNING]: "running",
    [ScrapeRunStatus.SUCCEEDED]: "succeeded",
    [ScrapeRunStatus.FAILED]: "failed",
    [ScrapeRunStatus.NEEDS_ADMIN_ACTION]: "needs_admin_action",
    [ScrapeRunStatus.THROTTLED]: "throttled",
  };
  const result = map[status];
  if (result === undefined) throw new Error(`Unknown DB scrape run status: ${status}`);
  return result;
}

/**
 * Ensure a Bank row exists for a given code (auto-provision pattern).
 * Returns the internal Bank.id (cuid).
 */
export async function upsertBankByCode(
  prisma: PrismaClient,
  code: string,
): Promise<string> {
  const bank = await prisma.bank.upsert({
    where: { code },
    update: {},
    create: { code, name: code },
    select: { id: true },
  });
  return bank.id;
}
