/**
 * Prisma-backed implementation of the scrape-run repository interface.
 * Satisfies the same contract as InMemoryScrapeRunRepository.
 *
 * Key decisions:
 * - Bank rows are auto-provisioned on first write (upsert by Bank.code).
 * - The domain bankId string is stored as Bank.code; list() joins Bank and
 *   returns Bank.code so consumers see no difference vs in-memory.
 * - Status transitions throw "Scrape run not found: <id>" to match in-memory.
 * - Sorting: filterScrapeRuns sorts by updatedAt desc; we replicate that.
 */

import type { Prisma } from "../../generated/prisma/client";
import type {
  ScrapeRunRecord,
  ScrapeRunFilters,
  CreateQueuedScrapeRunInput,
} from "../scrape-runs/index";
import {
  getPrismaClient,
  toDbScrapeRunStatus,
  fromDbScrapeRunStatus,
  upsertBankByCode,
} from "./prisma-client";

type ScrapeRunRow = {
  id: string;
  bank: { code: string };
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  insertedCount: number;
  skippedCount: number;
  safeErrorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const scrapeRunSelect = {
  id: true,
  bank: { select: { code: true } },
  status: true,
  startedAt: true,
  endedAt: true,
  insertedCount: true,
  skippedCount: true,
  safeErrorSummary: true,
  createdAt: true,
  updatedAt: true,
} as const;

function mapRow(row: ScrapeRunRow): ScrapeRunRecord {
  return {
    id: row.id,
    bankId: row.bank.code,
    status: fromDbScrapeRunStatus(row.status as Parameters<typeof fromDbScrapeRunStatus>[0]),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    insertedCount: row.insertedCount,
    skippedCount: row.skippedCount,
    safeErrorSummary: row.safeErrorSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaScrapeRunRepository {
  private get prisma() {
    return getPrismaClient();
  }

  async createQueued(input: CreateQueuedScrapeRunInput): Promise<ScrapeRunRecord> {
    const bankDbId = await upsertBankByCode(this.prisma, input.bankId);
    const now = input.createdAt ?? new Date();

    try {
      const row = await this.prisma.scrapeRun.create({
        data: {
          id: input.id,
          bankId: bankDbId,
          status: toDbScrapeRunStatus("queued"),
          createdAt: now,
          updatedAt: now,
        },
        select: scrapeRunSelect,
      });
      return mapRow(row);
    } catch (error: unknown) {
      // P2002: unique constraint violation (id already exists)
      if (isPrismaUniqueViolation(error)) {
        throw new Error(`Scrape run already exists: ${input.id}`);
      }
      throw error;
    }
  }

  async list(filters: ScrapeRunFilters): Promise<ScrapeRunRecord[]> {
    const where: Prisma.ScrapeRunWhereInput = {};

    if (filters.bankId) {
      where.bank = { code: filters.bankId };
    }

    if (filters.status) {
      where.status = toDbScrapeRunStatus(filters.status);
    }

    if (filters.dateFrom !== undefined) {
      const dateFrom = toDate(filters.dateFrom);
      where.createdAt = { ...(where.createdAt as object | undefined), gte: dateFrom };
    }

    if (filters.dateTo !== undefined) {
      const dateTo = toDate(filters.dateTo);
      where.createdAt = { ...(where.createdAt as object | undefined), lte: dateTo };
    }

    const rows = await this.prisma.scrapeRun.findMany({
      where,
      select: scrapeRunSelect,
      orderBy: { updatedAt: "desc" },
    });

    return rows.map(mapRow);
  }

  /**
   * Read a single scrape run by id, or null when it does not exist.
   *
   * Uses findUnique on the primary key so it is an indexed lookup — never a
   * full table scan. Mirrors InMemoryScrapeRunRepository.findById so the
   * single-run status endpoint can switch back ends without code changes.
   */
  async findById(runId: string): Promise<ScrapeRunRecord | null> {
    const row = await this.prisma.scrapeRun.findUnique({
      where: { id: runId },
      select: scrapeRunSelect,
    });
    return row ? mapRow(row) : null;
  }

  async markRunning(runId: string, startedAt = new Date()): Promise<void> {
    await this.updateOrThrow(runId, {
      status: toDbScrapeRunStatus("running"),
      startedAt,
      endedAt: null,
      safeErrorSummary: null,
      updatedAt: startedAt,
    });
  }

  async markSucceeded(
    runId: string,
    counts: { insertedCount: number; skippedCount: number },
    endedAt = new Date(),
  ): Promise<void> {
    await this.updateOrThrow(runId, {
      status: toDbScrapeRunStatus("succeeded"),
      endedAt,
      insertedCount: counts.insertedCount,
      skippedCount: counts.skippedCount,
      safeErrorSummary: null,
      updatedAt: endedAt,
    });
  }

  async markNeedsAdminAction(
    runId: string,
    safeErrorSummary: string,
    endedAt = new Date(),
  ): Promise<void> {
    await this.updateOrThrow(runId, {
      status: toDbScrapeRunStatus("needs_admin_action"),
      endedAt,
      safeErrorSummary,
      updatedAt: endedAt,
    });
  }

  async markThrottled(
    runId: string,
    safeErrorSummary: string,
    endedAt = new Date(),
  ): Promise<void> {
    await this.updateOrThrow(runId, {
      status: toDbScrapeRunStatus("throttled"),
      endedAt,
      safeErrorSummary,
      updatedAt: endedAt,
    });
  }

  async markFailed(
    runId: string,
    safeErrorSummary: string,
    endedAt = new Date(),
  ): Promise<void> {
    await this.updateOrThrow(runId, {
      status: toDbScrapeRunStatus("failed"),
      endedAt,
      safeErrorSummary,
      updatedAt: endedAt,
    });
  }

  private async updateOrThrow(
    runId: string,
    data: Prisma.ScrapeRunUncheckedUpdateInput,
  ): Promise<void> {
    try {
      await this.prisma.scrapeRun.update({
        where: { id: runId },
        data,
      });
    } catch (error: unknown) {
      if (isPrismaNotFoundError(error)) {
        throw new Error(`Scrape run not found: ${runId}`);
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function isPrismaNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2025"
  );
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
