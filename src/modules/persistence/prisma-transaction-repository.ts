/**
 * Prisma-backed implementation of the transaction repository interface.
 * Satisfies the same contract as InMemoryTransactionRepository.
 *
 * Key design decisions:
 * - Bank rows are auto-provisioned on first write (upsert by Bank.code).
 * - The domain bankId string ("popular") is stored as Bank.code; reads
 *   join the Bank table and return Bank.code so consumers see no difference
 *   vs the in-memory implementation.
 * - Dedup is performed by the DB UNIQUE constraint on sourceHash via
 *   createMany({ skipDuplicates: true }); within-batch duplicates are
 *   collapsed the same way (counted as skipped).
 * - Decimal round-trip: Prisma returns a Decimal object; we call toFixed(2)
 *   which exactly matches normalizeAmount output ("5424.00").
 */

import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type {
  TransactionRecord,
  TransactionFilters,
  ReviewState,
  UpsertResult,
} from "../transactions/index";
import {
  getPrismaClient,
  toDbDirection,
  fromDbDirection,
  toDbReviewState,
  fromDbReviewState,
  upsertBankByCode,
} from "./prisma-client";

// Type for a Transaction row joined with its Bank (for code lookup).
type TransactionWithBank = {
  id: string;
  bank: { code: string };
  accountFingerprint: string;
  postedAt: Date;
  amount: { toFixed: (n: number) => string };
  currency: string;
  direction: string;
  reference: string | null;
  concept: string | null;
  originator: string | null;
  reviewState: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  scrapeRunId: string | null;
  sourceHash: string;
  metadata: unknown;
};

function mapRow(row: TransactionWithBank): TransactionRecord {
  return {
    id: row.id,
    bankId: row.bank.code,
    accountFingerprint: row.accountFingerprint,
    postedAt: row.postedAt,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    direction: fromDbDirection(row.direction as "CREDIT" | "DEBIT"),
    reference: row.reference,
    concept: row.concept,
    originator: row.originator,
    reviewState: fromDbReviewState(row.reviewState as Parameters<typeof fromDbReviewState>[0]),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    scrapeRunId: row.scrapeRunId,
    sourceHash: row.sourceHash,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

const transactionSelect = {
  id: true,
  bank: { select: { code: true } },
  accountFingerprint: true,
  postedAt: true,
  amount: true,
  currency: true,
  direction: true,
  reference: true,
  concept: true,
  originator: true,
  reviewState: true,
  reviewedBy: true,
  reviewedAt: true,
  scrapeRunId: true,
  sourceHash: true,
  metadata: true,
} as const;

export class PrismaTransactionRepository {
  constructor(private readonly client?: PrismaClient) {}

  private get prisma() {
    return this.client ?? getPrismaClient();
  }

  async upsertMany(records: readonly TransactionRecord[]): Promise<UpsertResult> {
    if (records.length === 0) return { inserted: 0, skipped: 0 };

    // Auto-provision Bank rows for all distinct bankIds in this batch.
    const distinctBankCodes = [...new Set(records.map((r) => r.bankId))];
    const bankIdMap = new Map<string, string>(); // code -> DB id

    for (const code of distinctBankCodes) {
      const dbId = await upsertBankByCode(this.prisma, code);
      bankIdMap.set(code, dbId);
    }

    // Build createMany data; within-batch source-hash duplicates are deduplicated
    // by collecting into a Map first (matching in-memory skip semantics).
    const uniqueByHash = new Map<string, typeof dataItems[number]>();
    const dataItems: Prisma.TransactionCreateManyInput[] = [];

    for (const record of records) {
      if (uniqueByHash.has(record.sourceHash)) continue;

      const bankDbId = bankIdMap.get(record.bankId);
      if (!bankDbId) continue; // should not happen

      const item: Prisma.TransactionCreateManyInput = {
        id: record.id,
        bankId: bankDbId,
        accountId: null,
        accountFingerprint: record.accountFingerprint,
        postedAt: record.postedAt,
        amount: record.amount,
        currency: record.currency,
        direction: toDbDirection(record.direction),
        reference: record.reference ?? null,
        concept: record.concept ?? null,
        originator: record.originator ?? null,
        reviewState: toDbReviewState(record.reviewState),
        reviewedBy: record.reviewedBy ?? null,
        reviewedAt: record.reviewedAt ?? null,
        scrapeRunId: record.scrapeRunId ?? null,
        sourceHash: record.sourceHash,
        metadata: (record.metadata as Prisma.InputJsonValue | null) ?? undefined,
      };

      uniqueByHash.set(record.sourceHash, item);
      dataItems.push(item);
    }

    // skipDuplicates: ignore rows where the UNIQUE sourceHash constraint fires.
    const result = await this.prisma.transaction.createMany({
      data: dataItems,
      skipDuplicates: true,
    });

    const inserted = result.count;
    const skipped = records.length - inserted;

    return { inserted, skipped };
  }

  async list(filters: TransactionFilters): Promise<TransactionRecord[]> {
    // Build where clause mirroring filterTransactions semantics.
    const where: Prisma.TransactionWhereInput = {};

    if (filters.bankId) {
      where.bank = { code: filters.bankId };
    }

    if (filters.accountFingerprint) {
      where.accountFingerprint = filters.accountFingerprint;
    }

    if (filters.currency) {
      where.currency = filters.currency.toUpperCase();
    }

    if (filters.reviewState) {
      where.reviewState = toDbReviewState(filters.reviewState);
    }

    if (filters.amount !== undefined) {
      // normalizeAmount converts to toFixed(2) string; Decimal comparison.
      const normalizedAmount = normalizeAmountString(filters.amount);
      where.amount = normalizedAmount;
    }

    if (filters.dateFrom !== undefined) {
      const dateFrom = toDate(filters.dateFrom);
      where.postedAt = { ...(where.postedAt as object | undefined), gte: dateFrom };
    }

    if (filters.dateTo !== undefined) {
      const dateTo = toDate(filters.dateTo);
      where.postedAt = { ...(where.postedAt as object | undefined), lte: dateTo };
    }

    if (filters.query) {
      const q = filters.query.trim().toLowerCase();
      if (q) {
        const amountDecimal = safeDecimalFromQuery(q);
        where.OR = [
          { reference: { contains: q, mode: "insensitive" } },
          { concept: { contains: q, mode: "insensitive" } },
          { originator: { contains: q, mode: "insensitive" } },
          ...(amountDecimal !== undefined
            ? [{ amount: { equals: amountDecimal } }]
            : []),
        ] as Prisma.TransactionWhereInput[];
      }
    }

    const rows = await this.prisma.transaction.findMany({
      where,
      select: transactionSelect,
      orderBy: { postedAt: "desc" },
    });

    return rows.map(mapRow);
  }

  async updateReviewState(
    id: string,
    reviewState: ReviewState,
    reviewedBy: string,
    reviewedAt = new Date(),
  ): Promise<TransactionRecord | null> {
    try {
      const row = await this.prisma.transaction.update({
        where: { id },
        data: {
          reviewState: toDbReviewState(reviewState),
          reviewedBy,
          reviewedAt,
        },
        select: transactionSelect,
      });
      return mapRow(row);
    } catch (error: unknown) {
      if (isPrismaNotFoundError(error)) return null;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeAmountString(amount: string | number): string {
  const numeric = typeof amount === "number" ? amount : Number(String(amount).replace(/,/g, ""));
  if (!Number.isFinite(numeric)) throw new Error(`Invalid amount: ${amount}`);
  return numeric.toFixed(2);
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function safeDecimalFromQuery(q: string): string | undefined {
  const numeric = Number(q.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return undefined;
  return numeric.toFixed(2);
}

function isPrismaNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2025"
  );
}
