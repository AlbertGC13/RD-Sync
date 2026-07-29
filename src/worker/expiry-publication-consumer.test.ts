import { describe, expect, it, vi } from "vitest";

import { createExpiryPublicationConsumer } from "./expiry-publication-consumer";

const envelope = {
  bankCode: "popular",
  expiredEventId: "event-1",
  runId: "run-1",
  token: "publication-token",
};

function durable(overrides: Record<string, unknown> = {}) {
  return {
    ...envelope,
    expiredAuditDelivered: true,
    restoredAuditDelivered: false,
    publicationState: "published",
    publicationClaimToken: envelope.token,
    publicationFailureReportedAt: null,
    consumerClaimToken: null,
    consumerAttemptState: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function createConsumer(options: {
  current?: ReturnType<typeof durable> | null;
  claimed?: boolean;
  fingerprint?: string;
} = {}) {
  const episodes = {
    findByBankCode: vi.fn().mockResolvedValue(options.current ?? durable()),
    claimConsumerAttempt: vi.fn().mockResolvedValue(options.claimed ?? true),
    markConsumerResolved: vi.fn(),
  };
  const gate = { check: vi.fn().mockResolvedValue("eligible") };
  const ingest = vi.fn().mockResolvedValue({ status: "succeeded", inserted: 0, skipped: 0 });
  return {
    episodes,
    gate,
    ingest,
    consume: createExpiryPublicationConsumer({
      episodes,
      gate,
      ingest,
      resolveAccountFingerprint: (bankCode) => bankCode === "popular" ? options.fingerprint ?? "popular-0000000000" : undefined,
    }),
  };
}

describe("expiry publication consumer", () => {
  it("rejects invalid envelopes before a durable claim", async () => {
    const { consume, episodes } = createConsumer();

    await expect(consume({ ...envelope, token: " " })).rejects.toThrow("Invalid expiry publication queue hint");
    expect(episodes.findByBankCode).not.toHaveBeenCalled();
  });

  it("maps acquired and resumed claims to the exact ingestion payload", async () => {
    for (const current of [
      durable(),
      durable({ consumerClaimToken: "aa57745c5ef7ee5a61591cacf965abd74bca4f701ade36db5da5c358153a832b", consumerAttemptState: "reserved" }),
    ]) {
      const { consume, ingest } = createConsumer({ current, claimed: true });
      await consume(envelope);
      expect(ingest).toHaveBeenCalledWith({
        data: {
          bankId: "popular",
          expiredEventId: "event-1",
          runId: "run-1",
          accountFingerprint: "popular-0000000000",
        },
      });
    }
  });

  it("does not ingest ignored claims or unsupported bank profiles", async () => {
    const ignored = createConsumer({ current: durable({ consumerClaimToken: "other", consumerAttemptState: "reserved" }) });
    await ignored.consume(envelope);
    expect(ignored.ingest).not.toHaveBeenCalled();

    const unsupported = createConsumer({ fingerprint: "" });
    await unsupported.consume(envelope);
    expect(unsupported.ingest).not.toHaveBeenCalled();
    expect(unsupported.episodes.markConsumerResolved).toHaveBeenCalledOnce();
  });
});
