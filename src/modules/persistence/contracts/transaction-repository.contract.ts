/**
 * Reusable contract suite for transaction repository implementations.
 *
 * Usage:
 *   import { runTransactionRepositoryContract } from "./contracts/transaction-repository.contract";
 *
 *   runTransactionRepositoryContract(() => Promise.resolve({ repo: new InMemoryTransactionRepository(), cleanup: async () => {} }));
 *
 * The makeRepo factory is called once per describe block; cleanup is called in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { normalizeBankMovement } from "../../transactions/index";
import type {
  TransactionRecord,
  ReviewState,
} from "../../transactions/index";

export interface TransactionRepoHandle {
  repo: {
    upsertMany(records: readonly TransactionRecord[]): Promise<{ inserted: number; skipped: number }>;
    list(filters: {
      bankId?: string;
      accountFingerprint?: string;
      amount?: string | number;
      currency?: string;
      dateFrom?: string | Date;
      dateTo?: string | Date;
      query?: string;
      reviewState?: ReviewState;
    }): Promise<TransactionRecord[]>;
    updateReviewState(
      id: string,
      reviewState: ReviewState,
      reviewedBy: string,
      reviewedAt?: Date,
    ): Promise<TransactionRecord | null>;
  };
  cleanup(): Promise<void>;
}

export function runTransactionRepositoryContract(
  makeRepo: () => Promise<TransactionRepoHandle>,
): void {
  describe("TransactionRepository contract", () => {
    let handle: TransactionRepoHandle;

    beforeEach(async () => {
      handle = await makeRepo();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    // -------------------------------------------------------------------------
    // upsertMany — basic insert
    // -------------------------------------------------------------------------
    it("upserts a batch and reports inserted count", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-contract",
        postedAt: "2026-06-07T09:00:00-04:00",
        amount: "1000.00",
        currency: "DOP",
        direction: "credit",
      });

      const result = await handle.repo.upsertMany([record]);

      expect(result).toEqual({ inserted: 1, skipped: 0 });
    });

    // -------------------------------------------------------------------------
    // upsertMany — dedup by sourceHash (cross-call)
    // -------------------------------------------------------------------------
    it("skips duplicate sourceHash on second upsertMany call", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-contract",
        postedAt: "2026-06-07T09:00:00-04:00",
        amount: "1000.00",
        currency: "DOP",
        direction: "credit",
      });

      const first = await handle.repo.upsertMany([record]);
      const second = await handle.repo.upsertMany([{ ...record, id: "tx-dup" }]);

      expect(first).toEqual({ inserted: 1, skipped: 0 });
      expect(second).toEqual({ inserted: 0, skipped: 1 });
    });

    // -------------------------------------------------------------------------
    // upsertMany — within-batch sourceHash dedup
    // -------------------------------------------------------------------------
    it("skips within-batch sourceHash duplicates", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-contract",
        postedAt: "2026-06-07T09:15:00-04:00",
        amount: "500.00",
        currency: "DOP",
        direction: "credit",
      });

      // Same sourceHash twice in the same batch — only one should be inserted.
      const result = await handle.repo.upsertMany([record, { ...record, id: "tx-batch-dup" }]);

      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(1);
    });

    // -------------------------------------------------------------------------
    // Decimal round-trip MUST equal normalizeAmount output exactly
    // -------------------------------------------------------------------------
    it("preserves amount as toFixed(2) string on round-trip — e.g. 5424.00", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "popular-0000000000",
        postedAt: "2026-06-12T00:00:00-04:00",
        amount: "5424.00",
        currency: "DOP",
        direction: "credit",
        reference: "0000848679296",
        concept: "MB desde 848679296 Celenia Mar",
      });

      await handle.repo.upsertMany([record]);
      const results = await handle.repo.list({ bankId: "popular" });
      const found = results.find((r) => r.id === record.id);

      expect(found?.amount).toBe("5424.00");
    });

    // -------------------------------------------------------------------------
    // bankId round-trip ("popular" → stored via Bank.code → returned as "popular")
    // -------------------------------------------------------------------------
    it("returns the original bankId string on list()", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-bankid-rt",
        postedAt: "2026-06-07T10:00:00-04:00",
        amount: "200.00",
        currency: "DOP",
        direction: "debit",
      });

      await handle.repo.upsertMany([record]);
      const results = await handle.repo.list({ bankId: "popular" });

      expect(results.every((r) => r.bankId === "popular")).toBe(true);
    });

    // -------------------------------------------------------------------------
    // list — filter by bankId
    // -------------------------------------------------------------------------
    it("filters by bankId and returns records for that bank only", async () => {
      const popular = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-a",
        postedAt: "2026-06-07T11:00:00-04:00",
        amount: "100.00",
        currency: "DOP",
        direction: "credit",
      });
      const bhd = normalizeBankMovement({
        bankId: "bhd",
        accountFingerprint: "acct-b",
        postedAt: "2026-06-07T11:00:00-04:00",
        amount: "200.00",
        currency: "DOP",
        direction: "debit",
      });

      await handle.repo.upsertMany([popular, bhd]);
      const results = await handle.repo.list({ bankId: "popular" });

      expect(results.map((r) => r.bankId)).toEqual(["popular"]);
    });

    // -------------------------------------------------------------------------
    // list — newest-first ordering
    // -------------------------------------------------------------------------
    it("returns transactions newest-first by postedAt", async () => {
      const older = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-order",
        postedAt: "2026-06-06T09:00:00-04:00",
        amount: "300.00",
        currency: "DOP",
        direction: "credit",
      });
      const newer = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-order",
        postedAt: "2026-06-07T09:00:00-04:00",
        amount: "400.00",
        currency: "DOP",
        direction: "credit",
        reference: "newer-ref",
      });

      await handle.repo.upsertMany([older, newer]);
      const results = await handle.repo.list({ bankId: "popular" });

      // Newest first: newer.id should appear before older.id
      const ids = results.map((r) => r.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    });

    // -------------------------------------------------------------------------
    // updateReviewState — happy path
    // -------------------------------------------------------------------------
    it("updates review state and returns the updated record", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-review",
        postedAt: "2026-06-07T12:00:00-04:00",
        amount: "750.00",
        currency: "DOP",
        direction: "credit",
      });

      await handle.repo.upsertMany([record]);
      const updated = await handle.repo.updateReviewState(
        record.id,
        "seen",
        "reviewer-1",
        new Date("2026-06-07T13:00:00.000Z"),
      );

      expect(updated).not.toBeNull();
      expect(updated?.reviewState).toBe("seen");
      expect(updated?.reviewedBy).toBe("reviewer-1");
    });

    // -------------------------------------------------------------------------
    // updateReviewState — correct record targeted (same-day same-amount credit/debit)
    // -------------------------------------------------------------------------
    it("updates only the targeted record when two share date and amount but differ in direction", async () => {
      const credit = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "popular-0000000000",
        postedAt: "2026-06-12T00:00:00-04:00",
        amount: "5424.00",
        currency: "DOP",
        direction: "credit",
        reference: "0000848679296",
        concept: "MB desde 848679296 Celenia Mar",
      });
      const debit = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "popular-0000000000",
        postedAt: "2026-06-12T00:00:00-04:00",
        amount: "5424.00",
        currency: "DOP",
        direction: "debit",
        reference: "0000806851283",
        concept: "MB a 0806851283 SH PRODUCT SRL",
      });

      await handle.repo.upsertMany([credit, debit]);
      const updated = await handle.repo.updateReviewState(debit.id, "seen", "reviewer-1");

      expect(updated?.direction).toBe("debit");

      const all = await handle.repo.list({ bankId: "popular" });
      const creditAfter = all.find((r) => r.id === credit.id);
      expect(creditAfter?.reviewState).toBe("new");
    });

    // -------------------------------------------------------------------------
    // updateReviewState — not found returns null
    // -------------------------------------------------------------------------
    it("returns null when updating a non-existent transaction id", async () => {
      const result = await handle.repo.updateReviewState(
        "non-existent-id",
        "seen",
        "reviewer-1",
      );
      expect(result).toBeNull();
    });

    // -------------------------------------------------------------------------
    // filter by reviewState
    // -------------------------------------------------------------------------
    it("filters by reviewState", async () => {
      const record = normalizeBankMovement({
        bankId: "popular",
        accountFingerprint: "acct-rs",
        postedAt: "2026-06-07T14:00:00-04:00",
        amount: "123.45",
        currency: "DOP",
        direction: "credit",
      });

      await handle.repo.upsertMany([record]);
      await handle.repo.updateReviewState(record.id, "seen", "reviewer-2");

      const seen = await handle.repo.list({ reviewState: "seen" });
      const newOnly = await handle.repo.list({ reviewState: "new" });

      expect(seen.some((r) => r.id === record.id)).toBe(true);
      expect(newOnly.some((r) => r.id === record.id)).toBe(false);
    });
  });
}
