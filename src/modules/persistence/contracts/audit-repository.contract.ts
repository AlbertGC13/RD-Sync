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
    list(options?: { limit?: number; offset?: number }): Promise<AuditEvent[]>;
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
    // list — ordered newest-first
    // -------------------------------------------------------------------------
    it("lists events newest-first (createdAt DESC)", async () => {
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

      await handle.sink.record(earlier);
      await handle.sink.record(later);

      const events = await handle.sink.list();
      const actions = events.map((e) => e.action);

      // Newer event (ignored, 13:00) must come before older event (reviewed, 12:00).
      expect(actions.indexOf("transaction.ignored")).toBeLessThan(
        actions.indexOf("transaction.reviewed"),
      );
    });

    // -------------------------------------------------------------------------
    // list — no options returns all events
    // -------------------------------------------------------------------------
    it("returns all events when called with no options", async () => {
      const e1 = createAuditEvent({ actorId: null, actorRole: null, action: "a1", target: "t" });
      const e2 = createAuditEvent({ actorId: null, actorRole: null, action: "a2", target: "t" });
      const e3 = createAuditEvent({ actorId: null, actorRole: null, action: "a3", target: "t" });
      await handle.sink.record(e1);
      await handle.sink.record(e2);
      await handle.sink.record(e3);
      const events = await handle.sink.list();
      expect(events).toHaveLength(3);
    });

    // -------------------------------------------------------------------------
    // list — limit
    // -------------------------------------------------------------------------
    it("honours limit option", async () => {
      const base = new Date("2026-06-07T10:00:00.000Z");
      for (let i = 0; i < 5; i++) {
        const e: AuditEvent = {
          ...createAuditEvent({ actorId: null, actorRole: null, action: `action-${i}`, target: "t" }),
          createdAt: new Date(base.getTime() + i * 1000),
        };
        await handle.sink.record(e);
      }
      const events = await handle.sink.list({ limit: 3 });
      expect(events).toHaveLength(3);
    });

    // -------------------------------------------------------------------------
    // list — offset
    // -------------------------------------------------------------------------
    it("honours offset option", async () => {
      const base = new Date("2026-06-07T10:00:00.000Z");
      for (let i = 0; i < 5; i++) {
        const e: AuditEvent = {
          ...createAuditEvent({ actorId: null, actorRole: null, action: `ev-${i}`, target: "t" }),
          createdAt: new Date(base.getTime() + i * 1000),
        };
        await handle.sink.record(e);
      }
      const all = await handle.sink.list();
      const paged = await handle.sink.list({ offset: 2 });
      expect(paged).toHaveLength(3);
      expect(paged[0].action).toBe(all[2].action);
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
