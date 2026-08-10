import type { ManualRecoveryResolutionCommand, ManualRecoveryResolutionResult } from "./manual-recovery-resolution";
import { createAuditEvent, type AuditSink } from "../audit";
import { BANK_SESSION_ACTIONS } from "../audit/bank-actions";
import {
  createManualRecoveryReplayAuthorizedAudit,
  type ManualRecoveryReplayAuthorizationCandidate,
  type ManualRecoveryReplayAuthorizationResult,
  type ManualRecoveryReplayAuthorizationRepository,
} from "./manual-recovery-replay-authorization";
import { createExpiryTerminalAudit, EXPIRY_TERMINAL_OPERATOR_SIGNAL, type ExpiryTerminalFailureReason, type ExpiryTerminalReconciliationResult } from "./expiry-terminal-reconciliation";

export type SessionEpisodeAuditKind = "expired" | "restored";
export type EpisodePublicationState = "pending" | "publishing" | "published" | "cancelled";
export type ConsumerAttemptState = "reserved" | "mutation_started" | "manual_recovery_required" | "resolved";
export type ConsumerAttemptSource = "scheduled" | "scrape_time";
export const consumerAttemptTransitions = {
  mutationStarted: { from: "reserved", to: "mutation_started", requiresUnrestored: true },
  manualRecoveryRequired: { from: "mutation_started", to: "manual_recovery_required", requiresUnrestored: false },
} as const;
export type ConsumerAttemptTransition = (typeof consumerAttemptTransitions)[keyof typeof consumerAttemptTransitions];
export const PUBLICATION_CLAIM_TIMEOUT_MS = 30_000;

export function parseEpisodePublicationState(value: string, token: string | null, failure: Date | null): EpisodePublicationState {
  const claimed = Boolean(token?.trim());
  if (((value === "pending" || value === "cancelled") && token === null && failure === null) || (value === "publishing" && claimed) || (value === "published" && claimed && failure === null)) return value as EpisodePublicationState;
  throw new Error("Invalid publication tuple");
}
export function parseConsumerAttemptState(value: string | null, token: string | null): ConsumerAttemptState | null {
  if (value === null && token === null) return null;
  if (token?.trim() && (value === "reserved" || value === "mutation_started" || value === "manual_recovery_required" || value === "resolved")) return value;
  throw new Error("Invalid consumer attempt tuple");
}
export function parseConsumerAttemptLease(
  source: string | null,
  leaseExpiresAt: Date | null,
  attemptState: ConsumerAttemptState | null,
  publicationState: EpisodePublicationState,
  publicationClaimToken: string | null,
  terminalFailureReason: ExpiryTerminalFailureReason | null,
): { source: ConsumerAttemptSource | null; leaseExpiresAt: Date | null } {
  if (source === null && leaseExpiresAt === null) return { source: null, leaseExpiresAt: null };
  const active = attemptState === "reserved" || attemptState === "mutation_started";
  const terminal = attemptState === "manual_recovery_required" || attemptState === "resolved";
  if (
    (source !== "scheduled" && source !== "scrape_time")
    || (active && (leaseExpiresAt === null || terminalFailureReason !== null))
    || (terminal && leaseExpiresAt !== null)
    || (!active && !terminal)
    || (source === "scheduled" && publicationState !== "published")
    || (source === "scheduled" && !publicationClaimToken?.trim())
    || (source === "scrape_time" && publicationState === "published")
  ) throw new Error("Invalid consumer lease tuple");
  return { source, leaseExpiresAt };
}
function assertPublicationToken(token: string): void { if (!token.trim()) throw new Error("Publication token must be nonblank"); }
export function assertConsumerClaimToken(token: string): void { if (!token.trim()) throw new Error("Consumer claim token must be nonblank"); }
export interface BankSessionExpiryEpisode {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  expiredAuditDelivered: boolean;
  restoredAuditDelivered: boolean;
  publicationState: EpisodePublicationState;
  publicationClaimToken: string | null;
  publicationFailureReportedAt: Date | null;
  consumerClaimToken: string | null;
  consumerAttemptState: ConsumerAttemptState | null;
  consumerAttemptSource: ConsumerAttemptSource | null;
  consumerLeaseExpiresAt: Date | null;
  terminalFailureReason?: ExpiryTerminalFailureReason | null;
  terminalFailureReconciledAt?: Date | null;
  updatedAt: Date;
}

export type EpisodeCloseResult = "closed" | "retained_for_recovery" | "missing_or_stale";

export interface CreateBankSessionExpiryEpisodeInput {
  bankCode: string;
  expiredEventId: string;
  runId: string;
}

export interface GetOrCreateBankSessionExpiryEpisodeResult {
  episode: BankSessionExpiryEpisode;
  created: boolean;
}

export type ConsumerAttemptLeaseClaim =
  | { source: "scheduled"; envelope: ExpiryPublicationEnvelope; consumerClaimToken: string; leaseDurationMs: number }
  | { source: "scrape_time"; episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">; consumerClaimToken: string; leaseDurationMs: number };

function assertLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new Error("Consumer lease duration must be positive and finite");
}

export interface BankSessionExpiryEpisodeRepository {
  getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult>;
  findByBankCode(bankCode: string): Promise<BankSessionExpiryEpisode | null>;
  isAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean>;
  markAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean>;
  claimPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean>;
  markPublicationPublished(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean>;
  cancelPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<boolean>;
  markPublicationFailureReported(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean>;
  claimConsumerAttempt(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean>;
  claimConsumerAttemptLease(claim: ConsumerAttemptLeaseClaim): Promise<boolean>;
  renewConsumerAttemptLease(claim: ConsumerAttemptLeaseClaim): Promise<boolean>;
  /** Persists that a later worker phase may mutate credentials; it performs no mutation itself. */
  markConsumerMutationStarted(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean>;
  /** Persists a manual-recovery requirement; it performs no operator notification or audit delivery. */
  markConsumerManualRecoveryRequired(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean>;
  markConsumerResolved(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean>;
  resolveConsumerManualRecovery(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string, command: ManualRecoveryResolutionCommand): Promise<ManualRecoveryResolutionResult | null>;
  /** The monitor retains mutation_started/manual_recovery_required evidence; resolved episodes close normally. */
  close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult>;
}

export interface ExpiryPublicationEnvelope {
  bankCode: string;
  expiredEventId: string;
  token: string;
  runId: string;
}

/**
 * `schedule` and `observe` are kept distinct because they apply to different
 * episode states: `schedule` starts a NEW attempt for a freshly claimed
 * "publishing" episode, while `observe` only re-checks an already-"published"
 * episode's queue state without ever starting another attempt.
 */
export interface ExpiryPublicationPublisher {
  schedule(job: ExpiryPublicationEnvelope): Promise<unknown>;
  observe(job: ExpiryPublicationEnvelope): Promise<unknown>;
}

export async function publishExpiryEpisode(
  episodes: BankSessionExpiryEpisodeRepository,
  episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">,
  proposedToken: string,
  publisher: ExpiryPublicationPublisher,
): Promise<boolean> {
  assertPublicationToken(proposedToken);
  const durable = await episodes.findByBankCode(episode.bankCode);
  if (!durable || durable.expiredEventId !== episode.expiredEventId || durable.runId !== episode.runId || durable.restoredAuditDelivered) return false;
  const token = durable.publicationClaimToken ?? proposedToken;
  const publication = { bankCode: episode.bankCode, expiredEventId: episode.expiredEventId, runId: episode.runId, token };
  if (durable.publicationState === "published") {
    // Terminal queue failures observed here are intentionally left as durable
    // "published" — the caller's outer containment retries observe() on the
    // next cycle, pending PR4p's consumer/audit policy for this state.
    await publisher.observe(publication);
    return true;
  }
  if (!await episodes.claimPublication(episode, token)) return false;
  try {
    await publisher.schedule(publication);
  } catch (scheduleError) {
    try { await episodes.markPublicationFailureReported(episode, token); }
    catch (markerError) { throw new AggregateError([scheduleError, markerError], "Failed to schedule expiry episode", { cause: scheduleError }); }
    throw scheduleError;
  }
  return episodes.markPublicationPublished(episode, token);
}

const EPISODE_AUDIT_ACTOR = "system:session-monitor";

export async function deliverExpiryEpisodeAudit(
  auditSink: Pick<AuditSink, "record"> | undefined,
  episodes: BankSessionExpiryEpisodeRepository,
  episode: BankSessionExpiryEpisode,
  kind: SessionEpisodeAuditKind,
  checkedAt: string,
): Promise<boolean> {
  try {
    if (await episodes.isAuditDelivered(episode, kind)) return true;
    if (!auditSink) return false;
    const action = kind === "expired" ? BANK_SESSION_ACTIONS.EXPIRED : BANK_SESSION_ACTIONS.RESTORED;
    await auditSink.record(createAuditEvent({
      id: `bank-session-${action}:${episode.bankCode}:${episode.expiredEventId}`,
      actorId: EPISODE_AUDIT_ACTOR,
      actorRole: "system",
      action,
      target: "bank_session",
      targetId: null,
      metadata: { bankCode: episode.bankCode, expiredEventId: episode.expiredEventId, checkedAt },
    }));
    const marked = await episodes.markAuditDelivered(episode, kind);
    return marked || await episodes.isAuditDelivered(episode, kind);
  } catch {
    return false;
  }
}

export type ExpiryEpisodeRestorationResult = "closed" | "retained" | "missing_or_replaced";

/**
 * Restores one durable expiry episode without ever closing a replacement.
 * Audit delivery deliberately precedes publication cancellation and close.
 */
export async function restoreExpiryEpisode(
  auditSink: Pick<AuditSink, "record"> | undefined,
  episodes: BankSessionExpiryEpisodeRepository,
  episode: BankSessionExpiryEpisode,
  checkedAt: string,
): Promise<ExpiryEpisodeRestorationResult> {
  if (!await deliverExpiryEpisodeAudit(auditSink, episodes, episode, "expired", checkedAt)) {
    return reconcileRestorationEpisode(episodes, episode);
  }
  if (!await deliverExpiryEpisodeAudit(auditSink, episodes, episode, "restored", checkedAt)) {
    return reconcileRestorationEpisode(episodes, episode);
  }
  try {
    await episodes.cancelPublication(episode);
    if (await episodes.close(episode) === "closed") return "closed";
  } catch {
    // A durable lookup below decides whether this exact episode remains retryable.
  }
  return reconcileRestorationEpisode(episodes, episode);
}

async function reconcileRestorationEpisode(
  episodes: Pick<BankSessionExpiryEpisodeRepository, "findByBankCode">,
  observed: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">,
): Promise<"retained" | "missing_or_replaced"> {
  try {
    const current = await episodes.findByBankCode(observed.bankCode);
    return current
      && current.runId === observed.runId
      && current.expiredEventId === observed.expiredEventId
      ? "retained"
      : "missing_or_replaced";
  } catch {
    return "retained";
  }
}

export class InMemoryBankSessionExpiryEpisodeRepository implements BankSessionExpiryEpisodeRepository, ManualRecoveryReplayAuthorizationRepository {
  private readonly episodes = new Map<string, BankSessionExpiryEpisode>();
  private readonly resolutions: ManualRecoveryResolutionResult[] = [];
  private readonly outboxes: Array<{ resolutionId: string; state: "pending" | "delivering" | "delivered"; deliveredAt: Date | null }> = [];

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly failOutbox?: () => void,
  ) {}

  listManualRecoveryResolutions(): readonly ManualRecoveryResolutionResult[] {
    return this.resolutions.map((resolution) => ({ ...resolution, decision: { ...resolution.decision } }));
  }

  listManualRecoveryResolutionAuditOutboxes(): ReadonlyArray<{ resolutionId: string; state: "pending" | "delivering" | "delivered" }> {
    return this.outboxes.map(({ resolutionId, state }) => ({ resolutionId, state }));
  }
  async setManualRecoveryResolutionAuditState(resolutionId: string, state: "pending" | "delivering" | "delivered"): Promise<boolean> {
    const outbox = this.outboxes.find((item) => item.resolutionId === resolutionId);
    if (!outbox) return false;
    outbox.state = state; outbox.deliveredAt = state === "delivered" ? this.clock() : null;
    return true;
  }

  async getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult> {
    const existing = this.episodes.get(input.bankCode);
    if (existing) return { episode: { ...existing }, created: false };

    const episode: BankSessionExpiryEpisode = {
      ...input,
      expiredAuditDelivered: false,
      restoredAuditDelivered: false,
      publicationState: "pending",
      publicationClaimToken: null,
      publicationFailureReportedAt: null,
      consumerClaimToken: null,
      consumerAttemptState: null,
      consumerAttemptSource: null,
      consumerLeaseExpiresAt: null,
      terminalFailureReason: null,
      terminalFailureReconciledAt: null,
      updatedAt: this.clock(),
    };
    this.episodes.set(input.bankCode, episode);
    return { episode: { ...episode }, created: true };
  }
  async claimPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    assertPublicationToken(token);
    const staleBefore = new Date(this.clock().getTime() - PUBLICATION_CLAIM_TIMEOUT_MS);
    return this.updatePublication(episode, (current) =>
      !current.restoredAuditDelivered && current.consumerAttemptState === null && (
        current.publicationState === "pending" || (
          current.publicationState === "publishing"
          && current.publicationClaimToken === token
          && (current.publicationFailureReportedAt !== null || current.updatedAt < staleBefore)
        )
      ), (current) => ({
      ...current, publicationState: "publishing", publicationClaimToken: token, publicationFailureReportedAt: null,
    }));
  }
  async markPublicationPublished(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    assertPublicationToken(token); return this.updatePublication(episode, (current) => !current.restoredAuditDelivered && current.publicationState === "publishing" && current.publicationClaimToken === token, (current) => ({ ...current, publicationState: "published", publicationFailureReportedAt: null }));
  }
  async cancelPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<boolean> {
    return this.updatePublication(episode, (current) => current.publicationState === "pending" || current.publicationState === "publishing", (current) => ({ ...current, publicationState: "cancelled", publicationClaimToken: null, publicationFailureReportedAt: null }));
  }
  async markPublicationFailureReported(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    assertPublicationToken(token); return this.updatePublication(episode, (current) => current.publicationState === "publishing" && current.publicationClaimToken === token && current.publicationFailureReportedAt === null, (current) => ({ ...current, publicationFailureReportedAt: this.clock() }));
  }
  async claimConsumerAttempt(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    assertConsumerClaimToken(consumerClaimToken);
    return this.updatePublication(envelope, (current) => !current.restoredAuditDelivered && current.publicationState === "published" && current.publicationClaimToken === envelope.token && current.consumerClaimToken === null && current.consumerAttemptState === null, (current) => ({ ...current, consumerClaimToken, consumerAttemptState: "reserved" }));
  }
  async claimConsumerAttemptLease(claim: ConsumerAttemptLeaseClaim): Promise<boolean> {
    assertConsumerClaimToken(claim.consumerClaimToken); assertLeaseDuration(claim.leaseDurationMs);
    const episode = claim.source === "scheduled" ? claim.envelope : claim.episode;
    return this.updatePublication(episode, (current) =>
      !current.restoredAuditDelivered && current.terminalFailureReason === null && current.consumerClaimToken === null && current.consumerAttemptState === null
      && (claim.source === "scheduled"
        ? current.publicationState === "published" && current.publicationClaimToken === claim.envelope.token
        : current.publicationState === "pending" && current.publicationClaimToken === null),
    (current) => ({ ...current, consumerClaimToken: claim.consumerClaimToken, consumerAttemptState: "reserved", consumerAttemptSource: claim.source, consumerLeaseExpiresAt: new Date(this.clock().getTime() + claim.leaseDurationMs) }));
  }
  async renewConsumerAttemptLease(claim: ConsumerAttemptLeaseClaim): Promise<boolean> {
    assertConsumerClaimToken(claim.consumerClaimToken); assertLeaseDuration(claim.leaseDurationMs);
    const episode = claim.source === "scheduled" ? claim.envelope : claim.episode;
    return this.updatePublication(episode, (current) =>
      current.consumerClaimToken === claim.consumerClaimToken && current.consumerAttemptSource === claim.source
      && (current.consumerAttemptState === "reserved" || current.consumerAttemptState === "mutation_started")
      && current.terminalFailureReason === null && current.consumerLeaseExpiresAt !== null && current.consumerLeaseExpiresAt > this.clock()
      && (claim.source === "scheduled"
        ? current.publicationState === "published" && current.publicationClaimToken === claim.envelope.token
        : current.publicationState === "pending" && current.publicationClaimToken === null),
    (current) => ({ ...current, consumerLeaseExpiresAt: new Date(this.clock().getTime() + claim.leaseDurationMs) }));
  }
  async markConsumerMutationStarted(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    return this.transitionConsumerAttempt(envelope, consumerClaimToken, consumerAttemptTransitions.mutationStarted);
  }
  async markConsumerManualRecoveryRequired(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    return this.transitionConsumerAttempt(envelope, consumerClaimToken, consumerAttemptTransitions.manualRecoveryRequired);
  }
  async markConsumerResolved(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    assertConsumerClaimToken(consumerClaimToken);
    return this.updatePublication(envelope, (current) => current.publicationState === "published" && current.publicationClaimToken === envelope.token && current.consumerClaimToken === consumerClaimToken && (current.consumerLeaseExpiresAt === null || current.consumerLeaseExpiresAt > this.clock()) && (current.consumerAttemptState === "mutation_started" || (current.consumerAttemptState === "reserved" && !current.restoredAuditDelivered)), (current) => ({ ...current, consumerAttemptState: "resolved", consumerLeaseExpiresAt: null }));
  }
  async resolveConsumerManualRecovery(
    envelope: ExpiryPublicationEnvelope,
    consumerClaimToken: string,
    command: ManualRecoveryResolutionCommand,
  ): Promise<ManualRecoveryResolutionResult | null> {
    assertConsumerClaimToken(consumerClaimToken);
    const current = this.episodes.get(envelope.bankCode);
    if (
      !current
      || current.expiredEventId !== envelope.expiredEventId
      || current.runId !== envelope.runId
      || current.publicationState !== "published"
      || current.publicationClaimToken !== envelope.token
      || current.consumerClaimToken !== consumerClaimToken
      || current.consumerAttemptState !== "manual_recovery_required"
    ) return null;

    const resolvedAt = this.clock();
    const resolution: ManualRecoveryResolutionResult = {
      id: `resolution-${this.resolutions.length + 1}`,
      bankCode: current.bankCode,
      expiredEventId: current.expiredEventId,
      runId: current.runId,
      decision: { ...command.decision },
      operatorId: command.operatorId,
      resolvedAt,
    };
    this.failOutbox?.();
    this.episodes.set(envelope.bankCode, { ...current, consumerAttemptState: "resolved", updatedAt: resolvedAt });
    this.resolutions.push(resolution);
    this.outboxes.push({ resolutionId: resolution.id, state: "pending", deliveredAt: null });
    return { ...resolution, decision: { ...resolution.decision } };
  }

  async findManualRecoveryReplayBankCode(resolutionId: string): Promise<string | null> { return this.resolutions.find((resolution) => resolution.id === resolutionId)?.bankCode ?? null; }
  async authorizeManualRecoveryReplay(candidate: ManualRecoveryReplayAuthorizationCandidate): Promise<ManualRecoveryReplayAuthorizationResult> {
    const resolution = this.resolutions.find((item) => item.id === candidate.resolutionId); const outbox = this.outboxes.find((item) => item.resolutionId === candidate.resolutionId);
    if (!resolution || !outbox || resolution.decision.outcome !== "safe_to_retry" || resolution.decision.reason !== "verified_no_mutation" || outbox.state !== "delivered" || !outbox.deliveredAt) return { status: "ineligible" };
    const stored = resolution as ManualRecoveryResolutionResult & { replayExpiredEventId?: string; replayRunId?: string; replayAuthorizedAt?: Date };
    if (stored.replayExpiredEventId && stored.replayRunId && stored.replayAuthorizedAt) return this.replayResult("already_authorized", stored);
    if (!candidate.replayExpiredEventId.trim() || !candidate.replayRunId.trim() || candidate.replayExpiredEventId === candidate.replayRunId) throw new Error("Replay IDs must be nonblank and different");
    const current = this.episodes.get(resolution.bankCode);
    if (current && (current.expiredEventId !== resolution.expiredEventId || current.runId !== resolution.runId || current.publicationState !== "published" || current.consumerAttemptState !== "resolved")) return { status: "ineligible" };
    if (this.resolutions.some((item) => item.expiredEventId === candidate.replayExpiredEventId || item.runId === candidate.replayRunId || (item as typeof stored).replayExpiredEventId === candidate.replayExpiredEventId || (item as typeof stored).replayRunId === candidate.replayRunId)) throw new Error("Replay IDs conflict with durable identity");
    const replay: BankSessionExpiryEpisode = { bankCode: resolution.bankCode, expiredEventId: candidate.replayExpiredEventId, runId: candidate.replayRunId, expiredAuditDelivered: false, restoredAuditDelivered: false, publicationState: "pending", publicationClaimToken: null, publicationFailureReportedAt: null, consumerClaimToken: null, consumerAttemptState: null, consumerAttemptSource: null, consumerLeaseExpiresAt: null, updatedAt: candidate.authorizedAt };
    stored.replayExpiredEventId = candidate.replayExpiredEventId; stored.replayRunId = candidate.replayRunId; stored.replayAuthorizedAt = candidate.authorizedAt;
    this.episodes.set(resolution.bankCode, replay);
    return this.replayResult("authorized", stored);
  }
  async reconcileTerminalFailure(envelope: ExpiryPublicationEnvelope, reason: ExpiryTerminalFailureReason, reconciledAt: Date): Promise<ExpiryTerminalReconciliationResult> {
    const current = this.episodes.get(envelope.bankCode);
    if (!current || current.expiredEventId !== envelope.expiredEventId || current.runId !== envelope.runId || current.publicationState !== "published" || current.publicationClaimToken !== envelope.token || current.restoredAuditDelivered || current.consumerAttemptState === "resolved") {
      return { status: "ignored_stale_envelope", operatorSignal: EXPIRY_TERMINAL_OPERATOR_SIGNAL };
    }
    const storedReason = current.terminalFailureReason;
    if (storedReason === "job_failed" || storedReason === reason) {
      return {
        status: "already_reconciled", operatorSignal: EXPIRY_TERMINAL_OPERATOR_SIGNAL,
        audit: createExpiryTerminalAudit(envelope, storedReason ?? reason, current.terminalFailureReconciledAt ?? reconciledAt, current.consumerAttemptState === "mutation_started" || current.consumerAttemptState === "manual_recovery_required"),
      };
    }
    if (current.consumerLeaseExpiresAt !== null && current.consumerLeaseExpiresAt > this.clock()) return { status: "deferred_active_lease", operatorSignal: EXPIRY_TERMINAL_OPERATOR_SIGNAL };
    const requiresManualRecovery = current.consumerAttemptState === "mutation_started" || current.consumerAttemptState === "manual_recovery_required" || (current.consumerAttemptSource !== null && current.consumerAttemptState === "reserved");
    const updated = {
      ...current,
      consumerAttemptState: requiresManualRecovery ? "manual_recovery_required" as const : current.consumerAttemptState,
      consumerLeaseExpiresAt: requiresManualRecovery ? null : current.consumerLeaseExpiresAt,
      terminalFailureReason: reason,
      terminalFailureReconciledAt: current.terminalFailureReconciledAt ?? reconciledAt,
      updatedAt: this.clock(),
    };
    this.episodes.set(envelope.bankCode, updated);
    return { status: "reconciled", operatorSignal: EXPIRY_TERMINAL_OPERATOR_SIGNAL, audit: createExpiryTerminalAudit(envelope, reason, updated.terminalFailureReconciledAt, requiresManualRecovery) };
  }
  private replayResult(status: "authorized" | "already_authorized", resolution: ManualRecoveryResolutionResult & { replayExpiredEventId?: string; replayRunId?: string; replayAuthorizedAt?: Date }): ManualRecoveryReplayAuthorizationResult {
    return { status, replayExpiredEventId: resolution.replayExpiredEventId!, replayRunId: resolution.replayRunId!, audit: createManualRecoveryReplayAuthorizedAudit(resolution.id, resolution.operatorId, resolution.replayExpiredEventId!, resolution.replayRunId!, resolution.replayAuthorizedAt!) };
  }
  async findByBankCode(bankCode: string): Promise<BankSessionExpiryEpisode | null> {
    const episode = this.episodes.get(bankCode);
    return episode ? { ...episode } : null;
  }

  async isAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const current = this.episodes.get(episode.bankCode);
    return Boolean(current && current.runId === episode.runId && current[`${kind}AuditDelivered`]);
  }

  async markAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const current = this.episodes.get(episode.bankCode);
    const field = `${kind}AuditDelivered` as const;
    if (!current || current.runId !== episode.runId || current[field]) return false;
    const clearedReservation = kind === "restored" && current.consumerAttemptState === "reserved";
    this.episodes.set(episode.bankCode, {
      ...current,
      [field]: true,
      ...(clearedReservation ? { consumerClaimToken: null, consumerAttemptState: null, consumerAttemptSource: null, consumerLeaseExpiresAt: null } : {}),
    });
    return true;
  }

  async close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult> {
    const current = this.episodes.get(episode.bankCode);
    if (!current || current.runId !== episode.runId || current.expiredEventId !== episode.expiredEventId) {
      return "missing_or_stale";
    }
    if (current.consumerAttemptState && current.consumerAttemptState !== "resolved") return "retained_for_recovery";
    this.episodes.delete(episode.bankCode);
    return "closed";
  }

  private async updatePublication(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">,
    canUpdate: (current: BankSessionExpiryEpisode) => boolean,
    update: (current: BankSessionExpiryEpisode) => BankSessionExpiryEpisode,
  ): Promise<boolean> {
    const current = this.episodes.get(episode.bankCode);
    if (!current || current.expiredEventId !== episode.expiredEventId || current.runId !== episode.runId || !canUpdate(current)) return false;
    const updated = update(current);
    parseConsumerAttemptLease(updated.consumerAttemptSource, updated.consumerLeaseExpiresAt, updated.consumerAttemptState, updated.publicationState, updated.publicationClaimToken, updated.terminalFailureReason ?? null);
    this.episodes.set(episode.bankCode, { ...updated, updatedAt: this.clock() });
    return true;
  }

  private async transitionConsumerAttempt(
    envelope: ExpiryPublicationEnvelope,
    consumerClaimToken: string,
    transition: ConsumerAttemptTransition,
  ): Promise<boolean> {
    assertConsumerClaimToken(consumerClaimToken);
    return this.updatePublication(envelope, (current) =>
      (!transition.requiresUnrestored || !current.restoredAuditDelivered)
      && current.publicationState === "published"
      && current.publicationClaimToken === envelope.token
      && current.consumerClaimToken === consumerClaimToken
      && current.consumerAttemptState === transition.from
      && (current.consumerLeaseExpiresAt === null || current.consumerLeaseExpiresAt > this.clock()),
    (current) => ({ ...current, consumerAttemptState: transition.to, ...(transition.to === "manual_recovery_required" ? { consumerLeaseExpiresAt: null } : {}) }));
  }
}
