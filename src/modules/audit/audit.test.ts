import { describe, expect, it } from "vitest";

import { InMemoryAuditSink, createAuditEvent, redactAuditMetadata } from "./index";

describe("audit events", () => {
  it("redacts credentials, session tokens, and raw banking evidence", () => {
    const metadata = redactAuditMetadata({
      filter: { amount: "1000.00" },
      password: "secret",
      sessionToken: "token",
      rawHtml: "<table>bank</table>",
    });

    expect(metadata).toEqual({
      filter: { amount: "1000.00" },
      password: "[REDACTED]",
      sessionToken: "[REDACTED]",
      rawHtml: "[REDACTED]",
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
});
