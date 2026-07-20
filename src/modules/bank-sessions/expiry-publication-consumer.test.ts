import { describe, expect, it, vi } from "vitest";

import {
  evaluateExpiryPublicationClaimEligibility,
  InvalidExpiryPublicationEnvelopeError,
  reserveExpiryPublicationConsumerClaim,
  RetryableExpiryPublicationThrottleError,
  UnexpectedExpiryPublicationClaimResultError,
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
    consumerAttemptState: null,
    updatedAt: new Date("2026-07-17T00:00:00.000Z"),
    ...overrides,
  };
}

function createRepository(
  findByBankCode: BankSessionExpiryEpisodeRepository["findByBankCode"],
): Pick<BankSessionExpiryEpisodeRepository, "findByBankCode"> {
  return { findByBankCode };
}

function createReservationRepository(
  findByBankCode: BankSessionExpiryEpisodeRepository["findByBankCode"],
  claimConsumerAttempt: BankSessionExpiryEpisodeRepository["claimConsumerAttempt"],
): Pick<BankSessionExpiryEpisodeRepository, "findByBankCode" | "claimConsumerAttempt"> {
  return { findByBankCode, claimConsumerAttempt };
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

describe("reserveExpiryPublicationConsumerClaim", () => {
  it.each([
    ["null queue hint", null, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["array queue hint", [], "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["missing bank code", { ...envelope(), bankCode: undefined }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["blank bank code", { ...envelope(), bankCode: " " }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["missing expired event id", { ...envelope(), expiredEventId: undefined }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["blank expired event id", { ...envelope(), expiredEventId: " " }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["missing run id", { ...envelope(), runId: undefined }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["blank run id", { ...envelope(), runId: " " }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["missing publication token", { ...envelope(), token: undefined }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["blank publication token", { ...envelope(), token: " " }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["stale version", { ...envelope(), version: 0 }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["unsupported version", { ...envelope(), version: 2 }, "consumer-claim-1", InvalidExpiryPublicationEnvelopeError],
    ["blank consumer claim token", envelope(), " \t\n", Error],
  ] as const)("rejects a %s before durable, gate, or CAS access", async (_case, queuedHint, consumerClaimToken, error) => {
    const findByBankCode = vi.fn();
    const claimConsumerAttempt = vi.fn();
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(findByBankCode, claimConsumerAttempt),
        queuedHint,
        consumerClaimToken,
        gate,
      ),
    ).rejects.toBeInstanceOf(error);
    expect(findByBankCode).not.toHaveBeenCalled();
    expect(claimConsumerAttempt).not.toHaveBeenCalled();
    expect(gate.check).not.toHaveBeenCalled();
  });

  it("bypasses the pre-claim gate when the exact current envelope is already claimed", async () => {
    const findByBankCode = vi.fn().mockResolvedValue(durableEpisode({ consumerClaimToken: "existing-claim" }));
    const claimConsumerAttempt = vi.fn();
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(findByBankCode, claimConsumerAttempt),
        envelope(),
        "consumer-claim-2",
        gate,
      ),
    ).resolves.toEqual({ status: "ignored_already_claimed" });
    expect(gate.check).not.toHaveBeenCalled();
    expect(claimConsumerAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["restored", durableEpisode({ restoredAuditDelivered: true })],
    ["non-published", durableEpisode({ publicationState: "publishing" })],
    ["divergent", durableEpisode({ runId: "other-run" })],
  ] as const)("ignores a %s durable envelope without invoking the gate", async (_state, durable) => {
    const claimConsumerAttempt = vi.fn();
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockResolvedValue(durable), claimConsumerAttempt),
        envelope(),
        "consumer-claim-3",
        gate,
      ),
    ).resolves.toEqual({ status: "ignored_stale_envelope" });
    expect(gate.check).not.toHaveBeenCalled();
    expect(claimConsumerAttempt).not.toHaveBeenCalled();
  });

  it("propagates a safe throttle without writing a claim", async () => {
    const claimConsumerAttempt = vi.fn();
    const gate = createPreClaimGate("throttled");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockResolvedValue(durableEpisode()), claimConsumerAttempt),
        envelope(),
        "consumer-claim-4",
        gate,
      ),
    ).rejects.toBeInstanceOf(RetryableExpiryPublicationThrottleError);
    expect(claimConsumerAttempt).not.toHaveBeenCalled();
  });

  it("returns a reservation-only claim acquisition when the repository CAS wins", async () => {
    const claimConsumerAttempt = vi.fn().mockResolvedValue(true);
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockResolvedValue(durableEpisode()), claimConsumerAttempt),
        envelope(),
        "consumer-claim-5",
        gate,
      ),
    ).resolves.toEqual({ status: "claim_acquired" });
    expect(claimConsumerAttempt).toHaveBeenCalledWith(envelope(), "consumer-claim-5");
  });

  it.each([
    ["a claim written by another consumer", durableEpisode({ consumerClaimToken: "other-claim" }), "ignored_already_claimed"],
    ["a missing envelope", null, "ignored_stale_envelope"],
    ["a restored envelope", durableEpisode({ restoredAuditDelivered: true }), "ignored_stale_envelope"],
    ["a non-published envelope", durableEpisode({ publicationState: "pending", publicationClaimToken: null }), "ignored_stale_envelope"],
    ["a mismatched publication token", durableEpisode({ publicationClaimToken: "other-token" }), "ignored_stale_envelope"],
    ["a divergent envelope", durableEpisode({ expiredEventId: "other-event" }), "ignored_stale_envelope"],
  ] as const)("classifies failed CAS reloads for %s without running a second gate", async (_state, reloaded, status) => {
    const findByBankCode = vi.fn()
      .mockResolvedValueOnce(durableEpisode())
      .mockResolvedValueOnce(reloaded);
    const claimConsumerAttempt = vi.fn().mockResolvedValue(false);
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(findByBankCode, claimConsumerAttempt),
        envelope(),
        "consumer-claim-6",
        gate,
      ),
    ).resolves.toEqual({ status });
    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(claimConsumerAttempt).toHaveBeenCalledTimes(1);
  });

  it("throws when a failed CAS reload is still the exact unclaimed envelope", async () => {
    const findByBankCode = vi.fn()
      .mockResolvedValueOnce(durableEpisode())
      .mockResolvedValueOnce(durableEpisode());
    const claimConsumerAttempt = vi.fn().mockResolvedValue(false);
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(findByBankCode, claimConsumerAttempt),
        envelope(),
        "consumer-claim-7",
        gate,
      ),
    ).rejects.toBeInstanceOf(UnexpectedExpiryPublicationClaimResultError);
    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(claimConsumerAttempt).toHaveBeenCalledTimes(1);
  });

  it("propagates a pre-claim gate rejection without writing a claim", async () => {
    const gateError = new Error("capacity unavailable");
    const claimConsumerAttempt = vi.fn();
    const gate: ExpiryPublicationPreClaimGate = { check: vi.fn().mockRejectedValue(gateError) };

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockResolvedValue(durableEpisode()), claimConsumerAttempt),
        envelope(),
        "consumer-claim-7",
        gate,
      ),
    ).rejects.toBe(gateError);
    expect(claimConsumerAttempt).not.toHaveBeenCalled();
  });

  it("rejects an unexpected resolved gate result without writing a claim", async () => {
    const claimConsumerAttempt = vi.fn();
    const invalidGate: ExpiryPublicationPreClaimGate = {
      check: vi.fn().mockResolvedValue("unexpected" as unknown as "eligible"),
    };

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockResolvedValue(durableEpisode()), claimConsumerAttempt),
        envelope(),
        "consumer-claim-8",
        invalidGate,
      ),
    ).rejects.toBeInstanceOf(UnexpectedExpiryPublicationGateResultError);
    expect(claimConsumerAttempt).not.toHaveBeenCalled();
  });

  it("propagates the initial durable-load error object unchanged", async () => {
    const initialLoadError = new Error("database unavailable");
    const gate = createPreClaimGate("eligible");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockRejectedValue(initialLoadError), vi.fn()),
        envelope(),
        "consumer-claim-9",
        gate,
      ),
    ).rejects.toBe(initialLoadError);
    expect(gate.check).not.toHaveBeenCalled();
  });

  it("propagates the claim CAS error object unchanged", async () => {
    const claimError = new Error("claim unavailable");

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(vi.fn().mockResolvedValue(durableEpisode()), vi.fn().mockRejectedValue(claimError)),
        envelope(),
        "consumer-claim-10",
        createPreClaimGate("eligible"),
      ),
    ).rejects.toBe(claimError);
  });

  it("propagates the post-failed-CAS reload error object unchanged", async () => {
    const reloadError = new Error("reload unavailable");
    const findByBankCode = vi.fn()
      .mockResolvedValueOnce(durableEpisode())
      .mockRejectedValueOnce(reloadError);

    await expect(
      reserveExpiryPublicationConsumerClaim(
        createReservationRepository(findByBankCode, vi.fn().mockResolvedValue(false)),
        envelope(),
        "consumer-claim-11",
        createPreClaimGate("eligible"),
      ),
    ).rejects.toBe(reloadError);
  });
});
