import { describe, expect, it } from "vitest";

import { InMemoryAuditSink, createAuditEvent, redactAuditMetadata } from "./index";

describe("audit events", () => {
  it("redacts credentials, session tokens, and raw banking evidence", () => {
    const metadata = redactAuditMetadata({
      filter: { amount: "1000.00" },
      credential: "secret",
      envelope: "ciphertext",
      password: "secret",
      plaintext: "clear",
      sessionToken: "token",
      username: "operator",
      rawHtml: "<table>bank</table>",
      nested: { metadata: { username: "nested-user", credentialEnvelope: "nested-secret" } },
    });

    expect(metadata).toEqual({
      filter: { amount: "1000.00" },
      credential: "[REDACTED]",
      envelope: "[REDACTED]",
      password: "[REDACTED]",
      plaintext: "[REDACTED]",
      sessionToken: "[REDACTED]",
      username: "[REDACTED]",
      rawHtml: "[REDACTED]",
      nested: { metadata: { username: "[REDACTED]", credentialEnvelope: "[REDACTED]" } },
    });
  });

  it("records actor, action, target, and redacted metadata", async () => {
    const sink = new InMemoryAuditSink();
    const event = createAuditEvent({
      actorId: "u-1",
      actorRole: "reviewer",
      action: "transaction.reviewed",
      target: "transaction",
      targetId: "tx-1",
      metadata: { sessionCookie: "secret", reviewState: "seen" },
    });

    await sink.record(event);

    expect(await sink.list()).toEqual([
      expect.objectContaining({
        actorId: "u-1",
        actorRole: "reviewer",
        action: "transaction.reviewed",
        target: "transaction",
        targetId: "tx-1",
        metadata: { sessionCookie: "[REDACTED]", reviewState: "seen" },
      }),
    ]);
  });

  describe("InMemoryAuditSink.list() — pagination and ordering", () => {
    function makeEvent(action: string): Parameters<typeof createAuditEvent>[0] {
      return { actorId: null, actorRole: null, action, target: "t" };
    }

    it("returns events newest-first when no options provided", async () => {
      const sink = new InMemoryAuditSink();
      const base = new Date("2026-06-07T10:00:00.000Z");

      const older = { ...createAuditEvent(makeEvent("older")), createdAt: base };
      const newer = { ...createAuditEvent(makeEvent("newer")), createdAt: new Date(base.getTime() + 60_000) };

      await sink.record(older);
      await sink.record(newer);

      const events = await sink.list();
      expect(events[0].action).toBe("newer");
      expect(events[1].action).toBe("older");
    });

    it("returns all events when called with no options (backward compat)", async () => {
      const sink = new InMemoryAuditSink();
      for (let i = 0; i < 4; i++) {
        await sink.record(createAuditEvent({ actorId: null, actorRole: null, action: `a${i}`, target: "t" }));
      }
      expect((await sink.list()).length).toBe(4);
    });

    it("limits the result to the requested count", async () => {
      const sink = new InMemoryAuditSink();
      const base = new Date("2026-06-07T10:00:00.000Z");
      for (let i = 0; i < 5; i++) {
        const e = { ...createAuditEvent({ actorId: null, actorRole: null, action: `ev${i}`, target: "t" }), createdAt: new Date(base.getTime() + i * 1000) };
        await sink.record(e);
      }
      const events = await sink.list({ limit: 2 });
      expect(events).toHaveLength(2);
    });

    it("skips the requested number of events (offset)", async () => {
      const sink = new InMemoryAuditSink();
      const base = new Date("2026-06-07T10:00:00.000Z");
      for (let i = 0; i < 5; i++) {
        const e = { ...createAuditEvent({ actorId: null, actorRole: null, action: `ev${i}`, target: "t" }), createdAt: new Date(base.getTime() + i * 1000) };
        await sink.record(e);
      }
      const all = await sink.list();
      const paged = await sink.list({ offset: 2 });
      expect(paged).toHaveLength(3);
      expect(paged[0].action).toBe(all[2].action);
    });

    it("applies both offset and limit together", async () => {
      const sink = new InMemoryAuditSink();
      const base = new Date("2026-06-07T10:00:00.000Z");
      for (let i = 0; i < 6; i++) {
        const e = { ...createAuditEvent({ actorId: null, actorRole: null, action: `ev${i}`, target: "t" }), createdAt: new Date(base.getTime() + i * 1000) };
        await sink.record(e);
      }
      const events = await sink.list({ offset: 2, limit: 3 });
      expect(events).toHaveLength(3);
    });
  });
});
