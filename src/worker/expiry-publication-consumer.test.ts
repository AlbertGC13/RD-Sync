import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditSink } from "../modules/audit";
import { BANK_SESSION_ACTIONS } from "../modules/audit/bank-actions";
import { createRetiredExpiryPublicationConsumer } from "./expiry-publication-consumer";

const envelope = {
  bankCode: "popular",
  expiredEventId: "event-1",
  runId: "run-1",
  token: "publication-token",
};

function createConsumer() {
  const auditSink = new InMemoryAuditSink();
  return { auditSink, consume: createRetiredExpiryPublicationConsumer({ auditSink }) };
}

describe("retired expiry publication consumer", () => {
  it("acknowledges a valid envelope with a deterministic, safe audit event", async () => {
    const { auditSink, consume } = createConsumer();

    await expect(consume(envelope)).resolves.toEqual({ status: "acknowledged" });

    const [event] = await auditSink.list();
    expect(event).toMatchObject({
      id: expect.stringMatching(/^legacy_expiry_publication_retired:[a-f0-9]{64}$/),
      actorId: "system:ingestion-worker",
      action: BANK_SESSION_ACTIONS.LEGACY_EXPIRY_PUBLICATION_RETIRED,
      target: "bank_session_expiry_publication",
      targetId: null,
      metadata: {
        bankCode: "popular",
        expiredEventId: "event-1",
        runId: "run-1",
        reason: "legacy_expiry_publication_retired",
        outcome: "acknowledged",
      },
    });
    expect(JSON.stringify(event)).not.toContain(envelope.token);
  });

  it("uses one durable identity for repeated and BullMQ-like redelivery", async () => {
    const { auditSink, consume } = createConsumer();

    await consume(envelope);
    await consume({ ...envelope });

    const events = await auditSink.list();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("legacy_expiry_publication_retired:aa57745c5ef7ee5a61591cacf965abd74bca4f701ade36db5da5c358153a832b");
  });

  it("derives identity from every canonical envelope field without exposing its token", async () => {
    const first = createConsumer();
    const second = createConsumer();
    const third = createConsumer();

    await first.consume(envelope);
    await second.consume({ ...envelope, expiredEventId: "event-2" });
    await third.consume({ ...envelope, token: "different-publication-token" });

    const [firstEvent] = await first.auditSink.list();
    const [secondEvent] = await second.auditSink.list();
    const [thirdEvent] = await third.auditSink.list();
    expect(new Set([firstEvent.id, secondEvent.id, thirdEvent.id]).size).toBe(3);
    expect(JSON.stringify(thirdEvent)).not.toContain("different-publication-token");
  });

  it("rejects malformed input before audit mutation without invoking getters", async () => {
    const getter = vi.fn(() => "popular");
    const hidden = Object.create(null, {
      bankCode: { enumerable: true, value: "popular" },
      expiredEventId: { enumerable: true, value: "event-1" },
      runId: { enumerable: true, value: "run-1" },
      token: { enumerable: true, value: "publication-token" },
      hidden: { enumerable: false, value: "no" },
    });
    const withGetter = Object.defineProperty({ ...envelope }, "bankCode", { enumerable: true, get: getter });
    const invalid = [null, undefined, 1, "job", [], {}, { ...envelope, extra: "no" }, { ...envelope, token: " " }, hidden, withGetter, { ...envelope, [Symbol("hidden")]: "no" }];

    for (const data of invalid) {
      const { auditSink, consume } = createConsumer();
      await expect(consume(data)).rejects.toThrow("Invalid expiry publication queue hint");
      expect(await auditSink.list()).toHaveLength(0);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("has no processor, episode, browser, credential, lock, or alert dependency surface", async () => {
    const source = await readFile(new URL("./expiry-publication-consumer.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/bank-sessions|processor|browser|credential|lock|alert/i);
    const { consume } = createConsumer();
    await expect(consume(envelope)).resolves.toEqual({ status: "acknowledged" });
  });
});
