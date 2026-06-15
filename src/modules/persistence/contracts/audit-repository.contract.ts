/**
 * Reusable contract suite for audit sink implementations.
 *
 * Usage:
 *   import { runAuditRepositoryContract } from "./contracts/audit-repository.contract";
 *
 *   runAuditRepositoryContract(() => Promise.resolve({ sink: new InMemoryAuditSink(), cleanup: async () => {} }));
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAuditEvent } from "../../audit/index";
import type { AuditEvent } from "../../audit/index";

export interface AuditSinkHandle {
  sink: {
    record(event: AuditEvent): Promise<void>;
    list(): Promise<AuditEvent[]>;
  };
  cleanup(): Promise<void>;
}

export function runAuditRepositoryContract(
  makeRepo: () => Promise<AuditSinkHandle>,
): void {
  describe("AuditSink contract", () => {
    let handle: AuditSinkHandle;

    beforeEach(async () => {
      handle = await makeRepo();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    // -------------------------------------------------------------------------
    // record + list round-trip
    // -------------------------------------------------------------------------
    it("records an event and returns it via list()", async () => {
      const event = createAuditEvent({
        actorId: "system:ingestion-worker",
        actorRole: null,
        action: "scrape_run.started",
        target: "scrape_run",
        targetId: "run-1",
        metadata: { bankId: "popular" },
      });

      await handle.sink.record(event);
      const events = await handle.sink.list();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorId: "system:ingestion-worker",
        actorRole: null,
        action: "scrape_run.started",
        target: "scrape_run",
        targetId: "run-1",
      });
    });

    // -------------------------------------------------------------------------
    // list — ordered by insertion / createdAt
    // -------------------------------------------------------------------------
    it("lists events in insertion order (in-memory) or createdAt ascending (DB)", async () => {
      const earlier: AuditEvent = {
        ...createAuditEvent({
          actorId: "u-1",
          actorRole: "reviewer",
          action: "transaction.reviewed",
          target: "transaction",
          targetId: "tx-1",
        }),
        createdAt: new Date("2026-06-07T12:00:00.000Z"),
      };
      const later: AuditEvent = {
        ...createAuditEvent({
          actorId: "u-1",
          actorRole: "reviewer",
          action: "transaction.ignored",
          target: "transaction",
          targetId: "tx-2",
        }),
        createdAt: new Date("2026-06-07T13:00:00.000Z"),
      };

      // Insert in chronological order — both in-memory (insertion-order) and
      // Prisma (createdAt-order) should then return them in the same order.
      await handle.sink.record(earlier);
      await handle.sink.record(later);

      const events = await handle.sink.list();
      const actions = events.map((e) => e.action);

      expect(actions.indexOf("transaction.reviewed")).toBeLessThan(
        actions.indexOf("transaction.ignored"),
      );
    });

    // -------------------------------------------------------------------------
    // metadata preserved
    // -------------------------------------------------------------------------
    it("preserves metadata round-trip", async () => {
      const event = createAuditEvent({
        actorId: null,
        actorRole: null,
        action: "scrape_run.succeeded",
        target: "scrape_run",
        targetId: "run-2",
        metadata: { inserted: 5, skipped: 2 },
      });

      await handle.sink.record(event);
      const [recorded] = await handle.sink.list();

      expect(recorded.metadata).toEqual({ inserted: 5, skipped: 2 });
    });

    // -------------------------------------------------------------------------
    // null actor (system actor without a user record)
    // -------------------------------------------------------------------------
    it("records events with null actorId (opaque system actor string)", async () => {
      const event = createAuditEvent({
        actorId: "system:session-monitor",
        actorRole: null,
        action: "bank_session.checked",
        target: "bank_session",
        targetId: "session-abc",
      });

      await handle.sink.record(event);
      const [recorded] = await handle.sink.list();

      expect(recorded.actorId).toBe("system:session-monitor");
    });
  });
}
