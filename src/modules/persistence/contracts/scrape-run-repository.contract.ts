/**
 * Reusable contract suite for scrape-run repository implementations.
 *
 * Usage:
 *   import { runScrapeRunRepositoryContract } from "./contracts/scrape-run-repository.contract";
 *
 *   runScrapeRunRepositoryContract(() => Promise.resolve({ repo: new InMemoryScrapeRunRepository(), cleanup: async () => {} }));
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ScrapeRunRecord, ScrapeRunFilters } from "../../scrape-runs/index";

export interface ScrapeRunRepoHandle {
  repo: {
    createQueued(input: { id: string; bankId: string; createdAt?: Date }): Promise<ScrapeRunRecord>;
    list(filters: ScrapeRunFilters): Promise<ScrapeRunRecord[]>;
    markRunning(runId: string, startedAt?: Date): Promise<void>;
    markSucceeded(runId: string, counts: { insertedCount: number; skippedCount: number }, endedAt?: Date): Promise<void>;
    markNeedsAdminAction(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
    markFailed(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
  };
  cleanup(): Promise<void>;
}

export function runScrapeRunRepositoryContract(
  makeRepo: () => Promise<ScrapeRunRepoHandle>,
): void {
  describe("ScrapeRunRepository contract", () => {
    let handle: ScrapeRunRepoHandle;

    beforeEach(async () => {
      handle = await makeRepo();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    // -------------------------------------------------------------------------
    // createQueued — basic creation
    // -------------------------------------------------------------------------
    it("creates a queued run and returns it with bankId round-trip", async () => {
      const run = await handle.repo.createQueued({
        id: "run-contract-1",
        bankId: "popular",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
      });

      expect(run.id).toBe("run-contract-1");
      expect(run.bankId).toBe("popular");
      expect(run.status).toBe("queued");
      expect(run.insertedCount).toBe(0);
      expect(run.skippedCount).toBe(0);
    });

    // -------------------------------------------------------------------------
    // createQueued — duplicate throws
    // -------------------------------------------------------------------------
    it("throws when creating a scrape run with an existing id", async () => {
      await handle.repo.createQueued({
        id: "run-dup",
        bankId: "popular",
      });

      await expect(
        handle.repo.createQueued({ id: "run-dup", bankId: "popular" }),
      ).rejects.toThrow("Scrape run already exists: run-dup");
    });

    // -------------------------------------------------------------------------
    // list — newest-first ordering
    // -------------------------------------------------------------------------
    it("lists runs newest-first (by updatedAt)", async () => {
      await handle.repo.createQueued({
        id: "run-old",
        bankId: "popular",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
      });
      await handle.repo.createQueued({
        id: "run-new",
        bankId: "popular",
        createdAt: new Date("2026-06-08T13:00:00.000Z"),
      });

      const runs = await handle.repo.list({});
      const ids = runs.map((r) => r.id);

      expect(ids.indexOf("run-new")).toBeLessThan(ids.indexOf("run-old"));
    });

    // -------------------------------------------------------------------------
    // list — filter by bankId
    // -------------------------------------------------------------------------
    it("filters by bankId", async () => {
      await handle.repo.createQueued({ id: "run-pop", bankId: "popular" });
      await handle.repo.createQueued({ id: "run-bhd", bankId: "bhd" });

      const results = await handle.repo.list({ bankId: "popular" });

      expect(results.map((r) => r.id)).toContain("run-pop");
      expect(results.map((r) => r.id)).not.toContain("run-bhd");
    });

    // -------------------------------------------------------------------------
    // list — filter by status
    // -------------------------------------------------------------------------
    it("filters by status after a transition", async () => {
      await handle.repo.createQueued({
        id: "run-to-succeed",
        bankId: "popular",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
      });
      await handle.repo.markRunning("run-to-succeed");
      await handle.repo.markSucceeded(
        "run-to-succeed",
        { insertedCount: 5, skippedCount: 1 },
      );

      const succeeded = await handle.repo.list({ status: "succeeded" });
      expect(succeeded.some((r) => r.id === "run-to-succeed")).toBe(true);

      const queued = await handle.repo.list({ status: "queued" });
      expect(queued.some((r) => r.id === "run-to-succeed")).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Full lifecycle: queued → running → succeeded
    // -------------------------------------------------------------------------
    it("records full lifecycle transitions with timestamps and counts", async () => {
      const startedAt = new Date("2026-06-08T12:01:00.000Z");
      const endedAt = new Date("2026-06-08T12:02:00.000Z");

      await handle.repo.createQueued({
        id: "run-lifecycle",
        bankId: "popular",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
      });
      await handle.repo.markRunning("run-lifecycle", startedAt);
      await handle.repo.markSucceeded(
        "run-lifecycle",
        { insertedCount: 3, skippedCount: 1 },
        endedAt,
      );

      const [run] = await handle.repo.list({ status: "succeeded" });

      expect(run).toMatchObject({
        id: "run-lifecycle",
        status: "succeeded",
        insertedCount: 3,
        skippedCount: 1,
        startedAt,
        endedAt,
      });
    });

    // -------------------------------------------------------------------------
    // markNeedsAdminAction
    // -------------------------------------------------------------------------
    it("transitions to needs_admin_action with safe error summary", async () => {
      await handle.repo.createQueued({ id: "run-mfa", bankId: "popular" });
      await handle.repo.markNeedsAdminAction(
        "run-mfa",
        "Bank session requires admin MFA action",
        new Date("2026-06-08T12:03:00.000Z"),
      );

      const [run] = await handle.repo.list({ status: "needs_admin_action" });

      expect(run.status).toBe("needs_admin_action");
      expect(run.safeErrorSummary).toBe("Bank session requires admin MFA action");
    });

    // -------------------------------------------------------------------------
    // markFailed
    // -------------------------------------------------------------------------
    it("transitions to failed with safe error summary", async () => {
      await handle.repo.createQueued({ id: "run-fail", bankId: "popular" });
      await handle.repo.markFailed(
        "run-fail",
        "Transaction table selector missing",
        new Date("2026-06-08T12:04:00.000Z"),
      );

      const [run] = await handle.repo.list({ status: "failed" });

      expect(run.status).toBe("failed");
      expect(run.safeErrorSummary).toBe("Transaction table selector missing");
    });

    // -------------------------------------------------------------------------
    // markRunning — not found throws
    // -------------------------------------------------------------------------
    it("throws 'Scrape run not found' for missing run in markRunning", async () => {
      await expect(handle.repo.markRunning("non-existent")).rejects.toThrow(
        "Scrape run not found: non-existent",
      );
    });

    // -------------------------------------------------------------------------
    // list — date range filter
    // -------------------------------------------------------------------------
    it("filters by createdAt date range without leaking out-of-range records", async () => {
      await handle.repo.createQueued({
        id: "run-in-range",
        bankId: "popular",
        createdAt: new Date("2026-06-08T14:00:00.000Z"),
      });
      await handle.repo.createQueued({
        id: "run-out-range",
        bankId: "popular",
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
      });

      const results = await handle.repo.list({
        dateFrom: "2026-06-08T00:00:00.000Z",
        dateTo: "2026-06-08T23:59:59.999Z",
      });

      const ids = results.map((r) => r.id);
      expect(ids).toContain("run-in-range");
      expect(ids).not.toContain("run-out-range");
    });
  });
}
