import {
  assertConsumerClaimToken,
  type BankSessionExpiryEpisode,
  type BankSessionExpiryEpisodeRepository,
  type ExpiryPublicationEnvelope,
} from "./expiry-episodes";

export class InvalidExpiryPublicationEnvelopeError extends Error {
  constructor() {
    super("Invalid expiry publication queue hint");
    this.name = "InvalidExpiryPublicationEnvelopeError";
  }
}

export class RetryableExpiryPublicationThrottleError extends Error {
  constructor() {
    super("Expiry publication pre-claim check was throttled");
    this.name = "RetryableExpiryPublicationThrottleError";
  }
}

export class UnexpectedExpiryPublicationGateResultError extends Error {
  constructor() {
    super("Unexpected expiry publication pre-claim gate result");
    this.name = "UnexpectedExpiryPublicationGateResultError";
  }
}

export class UnexpectedExpiryPublicationClaimResultError extends Error {
  constructor() {
    super("Expiry publication consumer claim CAS failed without a durable state change");
    this.name = "UnexpectedExpiryPublicationClaimResultError";
  }
}

export interface ExpiryPublicationPreClaimGate {
  /**
   * Runs only before any credential mutation. A throttle at this boundary is
   * safe to retry because no submission has begun.
   */
  check(envelope: ExpiryPublicationEnvelope): Promise<"eligible" | "throttled">;
}

export type ExpiryPublicationClaimEligibility =
  | { status: "ignored_stale_envelope" }
  | { status: "eligible_for_claim" };

/**
 * A durable consumer reservation result. `claim_acquired` reserves one
 * consumer attempt only; it does not authorize any credential mutation.
 */
export type ExpiryPublicationConsumerClaimReservation =
  | { status: "ignored_stale_envelope" }
  | { status: "ignored_already_claimed" }
  | { status: "claim_acquired" };

/**
 * Determines whether a queue delivery may proceed to PR4p2's durable claim.
 * This boundary never authorizes a credential mutation.
 */
export async function evaluateExpiryPublicationClaimEligibility(
  episodes: Pick<BankSessionExpiryEpisodeRepository, "findByBankCode">,
  queuedHint: unknown,
  gate: ExpiryPublicationPreClaimGate,
): Promise<ExpiryPublicationClaimEligibility> {
  const queuedEnvelope = parseExpiryPublicationEnvelope(queuedHint);
  const durable = await episodes.findByBankCode(queuedEnvelope.bankCode);
  if (!isCurrentPublishedEnvelope(durable, queuedEnvelope)) {
    return { status: "ignored_stale_envelope" };
  }

  const gateOutcome = await gate.check(queuedEnvelope);
  if (gateOutcome === "throttled") throw new RetryableExpiryPublicationThrottleError();
  if (gateOutcome !== "eligible") throw new UnexpectedExpiryPublicationGateResultError();
  return { status: "eligible_for_claim" };
}

/**
 * Revalidates an untrusted delivery and reserves its durable consumer claim.
 * This operation is reservation-only and never authorizes credential mutation.
 * A rejected CAS must reload as claimed or stale; an exact unclaimed reload is
 * an invariant violation.
 */
export async function reserveExpiryPublicationConsumerClaim(
  episodes: Pick<BankSessionExpiryEpisodeRepository, "findByBankCode" | "claimConsumerAttempt">,
  queuedHint: unknown,
  consumerClaimToken: string,
  gate: ExpiryPublicationPreClaimGate,
): Promise<ExpiryPublicationConsumerClaimReservation> {
  const queuedEnvelope = parseExpiryPublicationEnvelope(queuedHint);
  assertConsumerClaimToken(consumerClaimToken);

  const durable = await episodes.findByBankCode(queuedEnvelope.bankCode);
  const initialStatus = classifyCurrentConsumerReservation(durable, queuedEnvelope);
  if (initialStatus) return initialStatus;

  const gateOutcome = await gate.check(queuedEnvelope);
  if (gateOutcome === "throttled") throw new RetryableExpiryPublicationThrottleError();
  if (gateOutcome !== "eligible") throw new UnexpectedExpiryPublicationGateResultError();

  if (await episodes.claimConsumerAttempt(queuedEnvelope, consumerClaimToken)) {
    return { status: "claim_acquired" };
  }

  return classifyFailedConsumerReservation(
    await episodes.findByBankCode(queuedEnvelope.bankCode),
    queuedEnvelope,
  );
}

function parseExpiryPublicationEnvelope(queuedHint: unknown): ExpiryPublicationEnvelope {
  if (typeof queuedHint !== "object" || queuedHint === null || Array.isArray(queuedHint)) {
    throw new InvalidExpiryPublicationEnvelopeError();
  }

  const hint = queuedHint as Record<string, unknown>;
  if (
    ("version" in hint && hint.version !== 1)
    || !isNonblankString(hint.bankCode)
    || !isNonblankString(hint.expiredEventId)
    || !isNonblankString(hint.runId)
    || !isNonblankString(hint.token)
  ) {
    throw new InvalidExpiryPublicationEnvelopeError();
  }

  return {
    bankCode: hint.bankCode,
    expiredEventId: hint.expiredEventId,
    runId: hint.runId,
    token: hint.token,
  };
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCurrentPublishedEnvelope(
  durable: BankSessionExpiryEpisode | null,
  queuedEnvelope: ExpiryPublicationEnvelope,
): boolean {
  return durable !== null
    && !durable.restoredAuditDelivered
    && durable.publicationState === "published"
    && durable.bankCode === queuedEnvelope.bankCode
    && durable.expiredEventId === queuedEnvelope.expiredEventId
    && durable.runId === queuedEnvelope.runId
    && durable.publicationClaimToken === queuedEnvelope.token;
}

function classifyCurrentConsumerReservation(
  durable: BankSessionExpiryEpisode | null,
  queuedEnvelope: ExpiryPublicationEnvelope,
): Exclude<ExpiryPublicationConsumerClaimReservation, { status: "claim_acquired" }> | null {
  if (!isCurrentPublishedEnvelope(durable, queuedEnvelope)) return { status: "ignored_stale_envelope" };
  return hasNonblankConsumerClaim(durable) ? { status: "ignored_already_claimed" } : null;
}

function classifyFailedConsumerReservation(
  durable: BankSessionExpiryEpisode | null,
  queuedEnvelope: ExpiryPublicationEnvelope,
): Exclude<ExpiryPublicationConsumerClaimReservation, { status: "claim_acquired" }> {
  if (!isCurrentPublishedEnvelope(durable, queuedEnvelope)) return { status: "ignored_stale_envelope" };
  if (hasNonblankConsumerClaim(durable)) return { status: "ignored_already_claimed" };
  throw new UnexpectedExpiryPublicationClaimResultError();
}

function hasNonblankConsumerClaim(durable: BankSessionExpiryEpisode | null): boolean {
  return Boolean(durable?.consumerClaimToken?.trim());
}
