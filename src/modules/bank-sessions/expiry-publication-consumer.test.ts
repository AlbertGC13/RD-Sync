import { describe, expect, it, vi } from "vitest";

import {
  evaluateExpiryPublicationClaimEligibility,
  InvalidExpiryPublicationEnvelopeError,
  RetryableExpiryPublicationThrottleError,
  UnexpectedExpiryPublicationGateResultError,
  type ExpiryPublicationPreClaimGate,
} from "./expiry-publication-consumer";
import {
  type BankSessionExpiryEpisode,
  type BankSessionExpiryEpisodeRepository,
  type ExpiryPublicationEnvelope,
} from "./expiry-episodes";

const episode = {
  bankCode: "popular",
  expiredEventId: "event-1",
  runId: "popular-expiry-event-1",
} as const;

const envelope = (overrides: Partial<ExpiryPublicationEnvelope> = {}): ExpiryPublicationEnvelope => ({
  ...episode,
  token: "token-1",
  ...overrides,
});

function durableEpisode(overrides: Partial<BankSessionExpiryEpisode> = {}): BankSessionExpiryEpisode {
  return {
    ...episode,
    expiredAuditDelivered: true,
    restoredAuditDelivered: false,
    publicationState: "published",
    publicationClaimToken: "token-1",
    publicationFailureReportedAt: null,
    consumerClaimToken: null,
    updatedAt: new Date("2026-07-17T00:00:00.000Z"),
    ...overrides,
  };
}

function createRepository(
  findByBankCode: BankSessionExpiryEpisodeRepository["findByBankCode"],
): Pick<BankSessionExpiryEpisodeRepository, "findByBankCode"> {
  return { findByBankCode };
}

function createPreClaimGate(
  outcome: "eligible" | "throttled",
): ExpiryPublicationPreClaimGate {
  return { check: vi.fn().mockResolvedValue(outcome) };
}

describe("evaluateExpiryPublicationClaimEligibility", () => {
  it.each([
    ["null", null],
    ["missing bank code", { ...envelope(), bankCode: undefined }],
    ["blank bank code", { ...envelope(), bankCode: " " }],
    ["missing expired event id", { ...envelope(), expiredEventId: undefined }],
    ["blank expired event id", { ...envelope(), expiredEventId: " " }],
    ["missing run id", { ...envelope(), runId: undefined }],
    ["blank run id", { ...envelope(), runId: " " }],
    ["missing token", { ...envelope(), token: undefined }],
    ["blank token", { ...envelope(), token: " " }],
    ["stale version", { ...envelope(), version: 0 }],
  ])("fails closed for a %s queue hint before reading durable state", async (_name, queuedHint) => {
    const findByBankCode = vi.fn();
    const gate = createPreClaimGate("eligible");

    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(findByBankCode), queuedHint, gate),
    ).rejects.toBeInstanceOf(InvalidExpiryPublicationEnvelopeError);
    expect(findByBankCode).not.toHaveBeenCalled();
    expect(gate.check).not.toHaveBeenCalled();
  });

  it.each([
    ["bank code", { ...envelope(), bankCode: "bhd" }],
    ["expired event id", { ...envelope(), expiredEventId: "event-2" }],
    ["run id", { ...envelope(), runId: "popular-expiry-event-2" }],
    ["claim token", { ...envelope(), token: "token-2" }],
  ] as const)(
    "does not invoke the pre-claim gate when the queued %s disagrees with the durable envelope",
    async (_field, queuedEnvelope) => {
      const episodes = createRepository(vi.fn().mockResolvedValue(durableEpisode()));
      const gate = createPreClaimGate("eligible");

      await expect(evaluateExpiryPublicationClaimEligibility(episodes, queuedEnvelope, gate)).resolves.toEqual({
        status: "ignored_stale_envelope",
      });
      expect(gate.check).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", null],
    ["restored", durableEpisode({ restoredAuditDelivered: true })],
    ["pending", durableEpisode({ publicationState: "pending", publicationClaimToken: null })],
    ["publishing", durableEpisode({ publicationState: "publishing" })],
    ["cancelled", durableEpisode({ publicationState: "cancelled", publicationClaimToken: null })],
  ] as const)("fails closed when the durable episode is %s", async (_state, durable) => {
    const gate = createPreClaimGate("eligible");

    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(vi.fn().mockResolvedValue(durable)), envelope(), gate),
    ).resolves.toEqual({ status: "ignored_stale_envelope" });
    expect(gate.check).not.toHaveBeenCalled();
  });

  it("returns only pre-claim eligibility after matching the current durable envelope", async () => {
    const gate = createPreClaimGate("eligible");

    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(vi.fn().mockResolvedValue(durableEpisode())), envelope(), gate),
    ).resolves.toEqual({ status: "eligible_for_claim" });
    expect(gate.check).toHaveBeenCalledWith(envelope());
  });

  it("looks up and accepts a matching banreservas durable episode by its own bank code", async () => {
    const queuedEnvelope = envelope({
      bankCode: "banreservas",
      expiredEventId: "banreservas-event-1",
      runId: "banreservas-expiry-event-1",
      token: "banreservas-token-1",
    });
    const findByBankCode = vi.fn().mockResolvedValue(durableEpisode({
      bankCode: queuedEnvelope.bankCode,
      expiredEventId: queuedEnvelope.expiredEventId,
      runId: queuedEnvelope.runId,
      publicationClaimToken: queuedEnvelope.token,
    }));
    const gate = createPreClaimGate("eligible");

    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(findByBankCode), queuedEnvelope, gate),
    ).resolves.toEqual({ status: "eligible_for_claim" });
    expect(findByBankCode).toHaveBeenCalledWith("banreservas");
    expect(gate.check).toHaveBeenCalledWith(queuedEnvelope);
  });

  it("rejects a safe pre-claim throttle and revalidates durable state before retry", async () => {
    const findByBankCode = vi.fn()
      .mockResolvedValueOnce(durableEpisode())
      .mockResolvedValueOnce(durableEpisode({ restoredAuditDelivered: true }));
    const episodes = createRepository(findByBankCode);
    const throttledGate = createPreClaimGate("throttled");

    const throttledAttempt = evaluateExpiryPublicationClaimEligibility(episodes, envelope(), throttledGate);
    await expect(throttledAttempt).rejects.toBeInstanceOf(RetryableExpiryPublicationThrottleError);
    await expect(throttledAttempt).rejects.toMatchObject({
      name: "RetryableExpiryPublicationThrottleError",
      message: "Expiry publication pre-claim check was throttled",
    });

    const eligiblePreClaimGate = createPreClaimGate("eligible");
    await expect(evaluateExpiryPublicationClaimEligibility(episodes, envelope(), eligiblePreClaimGate)).resolves.toEqual({
      status: "ignored_stale_envelope",
    });
    expect(throttledGate.check).toHaveBeenCalledWith(envelope());
    expect(eligiblePreClaimGate.check).not.toHaveBeenCalled();
  });

  it("rejects an unexpected gate result as an invariant violation instead of a throttle", async () => {
    const invalidGate: ExpiryPublicationPreClaimGate = {
      check: vi.fn().mockResolvedValue("unexpected" as unknown as "eligible"),
    };

    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(vi.fn().mockResolvedValue(durableEpisode())), envelope(), invalidGate),
    ).rejects.toMatchObject({
      name: "UnexpectedExpiryPublicationGateResultError",
      message: "Unexpected expiry publication pre-claim gate result",
    });
    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(vi.fn().mockResolvedValue(durableEpisode())), envelope(), invalidGate),
    ).rejects.toBeInstanceOf(UnexpectedExpiryPublicationGateResultError);
  });

  it("propagates durable-load and pre-claim gate rejections without authorizing a claim", async () => {
    const persistenceError = new Error("database unavailable");
    const gate = createPreClaimGate("eligible");
    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(vi.fn().mockRejectedValue(persistenceError)), envelope(), gate),
    ).rejects.toBe(persistenceError);
    expect(gate.check).not.toHaveBeenCalled();

    const gateError = new Error("capacity unavailable");
    const rejectingGate: ExpiryPublicationPreClaimGate = { check: vi.fn().mockRejectedValue(gateError) };
    await expect(
      evaluateExpiryPublicationClaimEligibility(createRepository(vi.fn().mockResolvedValue(durableEpisode())), envelope(), rejectingGate),
    ).rejects.toBe(gateError);
  });
});
