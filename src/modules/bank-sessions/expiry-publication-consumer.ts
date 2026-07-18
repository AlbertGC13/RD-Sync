import type {
  BankSessionExpiryEpisodeRepository,
  ExpiryPublicationEnvelope,
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
  durable: Awaited<ReturnType<BankSessionExpiryEpisodeRepository["findByBankCode"]>>,
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
