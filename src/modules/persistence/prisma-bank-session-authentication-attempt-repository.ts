import type { PrismaClient } from "../../generated/prisma/client";
import {
  parseSessionAuthenticationAttemptRecord,
  type AcquireSessionAuthenticationLeaseInput,
  type AcquireSessionAuthenticationLeaseResult,
  type BeginCredentialInteractionInput,
  type BeginCredentialInteractionResult,
  type ClaimRetryInput,
  type ClaimSessionAuthenticationRetryResult,
  type CompleteAuthenticatedInput,
  type CompleteAuthenticatedResult,
  type CompleteFailedInput,
  type CompleteFailedResult,
  type FindExactSessionAuthenticationAttemptInput,
  type FindExactSessionAuthenticationAttemptResult,
  type GetOrCreateSessionAuthenticationAttemptInput,
  type GetOrCreateSessionAuthenticationAttemptResult,
  type RecordSessionAuthenticationSubmitBarrierResult,
  type RecordSubmitBarrierInput,
  type ReconcileExpiredLeaseInput,
  type ReconcileExpiredLeaseResult,
  type RenewSessionAuthenticationLeaseInput,
  type RenewSessionAuthenticationLeaseResult,
  type SessionAuthenticationAttemptRecord,
  type SessionAuthenticationAttemptRepository,
  type ObservedRestorationResolver,
  type ResolveObservedRestorationResult,
  type SessionAuthenticationLeaseOwner,
} from "../bank-sessions/session-authentication-attempt-repository";

type Row = {
  bankCode: unknown; runId: unknown; attemptId: unknown; status: unknown; interactionPhase: unknown;
  failureClass: unknown; operatorReason: unknown; retryCount: unknown; ownerToken: unknown;
  generation: unknown; leaseExpiresAt: unknown; terminalAt: unknown; createdAt: unknown; updatedAt: unknown;
};

function record(row: Row): SessionAuthenticationAttemptRecord {
  const parsed = parseSessionAuthenticationAttemptRecord(row);
  if (!parsed) throw new Error("Invalid durable session authentication attempt record");
  return parsed;
}

function assertLease(ownerToken: string, duration: number): void {
  if (!ownerToken.trim()) throw new Error("Session authentication owner token must be nonblank");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Session authentication lease duration must be positive and finite");
}
function assertObservedOwner(owner: SessionAuthenticationLeaseOwner): void {
  if (![owner.identity.bankCode, owner.identity.runId, owner.identity.attemptId, owner.ownerToken].every((value) => value.trim())) throw new Error("Observed restoration identity and owner must be nonblank");
  if (owner.generation < 0n) throw new Error("Observed restoration generation must be nonnegative");
}

function sameOwner(current: SessionAuthenticationAttemptRecord, owner: { ownerToken: string; generation: bigint }): boolean {
  return current.status === "active" && current.ownerToken === owner.ownerToken && current.generation === owner.generation;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === "23505") return true;
  if (!isRecord(error.meta)) return false;
  if (error.meta.code === "23505") return true;
  if (!isRecord(error.meta.driverAdapterError)) return false;
  // Prisma 7 raw queries wrap PostgreSQL 23505 as P2010 and preserve the SQLSTATE only in the driver-adapter cause.
  const cause = error.meta.driverAdapterError.cause;
  return isRecord(cause) && cause.kind === "UniqueConstraintViolation" && cause.originalCode === "23505";
}

export class PrismaBankSessionAuthenticationAttemptRepository implements SessionAuthenticationAttemptRepository, ObservedRestorationResolver {
  constructor(private readonly prisma: PrismaClient) {}

  private async find(input: { identity: { bankCode: string; runId: string; attemptId: string } }): Promise<SessionAuthenticationAttemptRecord | null> {
    const { identity } = input;
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt" FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = ${identity.bankCode} AND "runId" = ${identity.runId} AND "attemptId" = ${identity.attemptId}`;
    return rows[0] ? record(rows[0]) : null;
  }

  private async findByBankRun(identity: { bankCode: string; runId: string }): Promise<SessionAuthenticationAttemptRecord | null> {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt" FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = ${identity.bankCode} AND "runId" = ${identity.runId}`;
    return rows[0] ? record(rows[0]) : null;
  }

  private async ownerState(owner: { identity: { bankCode: string; runId: string; attemptId: string }; ownerToken: string; generation: bigint }) {
    const rows = await this.prisma.$queryRaw<Array<Row & { leaseActive: boolean }>>`SELECT "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt", COALESCE("leaseExpiresAt" > NOW(), FALSE) AS "leaseActive" FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId}`;
    const row = rows[0];
    if (!row) return { status: "missing" } as const;
    const current = record(row);
    if (current.status !== "active") return { status: "terminal" } as const;
    if (!sameOwner(current, owner)) return { status: "stale_owner" } as const;
    if (!row.leaseActive) return { status: "lease_expired" } as const;
    return { status: "current", record: current } as const;
  }

  async getOrCreate({ identity }: GetOrCreateSessionAuthenticationAttemptInput): Promise<GetOrCreateSessionAuthenticationAttemptResult> {
    let inserted: Row[] = [];
    try {
      inserted = await this.prisma.$queryRaw<Row[]>`INSERT INTO "BankSessionAuthenticationAttempt" ("bankCode", "runId", "attemptId", "updatedAt") VALUES (${identity.bankCode}, ${identity.runId}, ${identity.attemptId}, NOW()) RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    if (inserted[0]) return { status: "created", record: record(inserted[0]) };
    const existing = await this.findByBankRun(identity);
    if (!existing) throw new Error("Session authentication attempt unavailable after insert conflict");
    return existing.identity.attemptId === identity.attemptId
      ? { status: "found", record: existing }
      : { status: "identity_conflict", existingAttemptId: existing.identity.attemptId };
  }

  async findExact({ identity }: FindExactSessionAuthenticationAttemptInput): Promise<FindExactSessionAuthenticationAttemptResult> {
    const current = await this.find({ identity });
    return current ? { status: "found", record: current } : { status: "missing" };
  }

  async acquireLease({ identity, ownerToken, leaseDurationMs }: AcquireSessionAuthenticationLeaseInput): Promise<AcquireSessionAuthenticationLeaseResult> {
    assertLease(ownerToken, leaseDurationMs);
    const rows = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "ownerToken" = ${ownerToken}, "generation" = "generation" + 1, "leaseExpiresAt" = NOW() + (${leaseDurationMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "bankCode" = ${identity.bankCode} AND "runId" = ${identity.runId} AND "attemptId" = ${identity.attemptId} AND "status" = 'active' AND "ownerToken" IS NULL AND "leaseExpiresAt" IS NULL RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (rows[0]) { const current = record(rows[0]); return { status: "lease_acquired", owner: { identity, ownerToken, generation: current.generation }, record: current }; }
    const diagnostics = await this.prisma.$queryRaw<Array<Row & { leaseActive: boolean }>>`SELECT "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt", COALESCE("leaseExpiresAt" > NOW(), FALSE) AS "leaseActive" FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = ${identity.bankCode} AND "runId" = ${identity.runId} AND "attemptId" = ${identity.attemptId}`;
    const current = diagnostics[0];
    if (!current) return { status: "missing" };
    const parsed = record(current);
    if (parsed.status !== "active") return { status: "terminal", record: parsed };
    if (parsed.ownerToken === null) return { status: "not_applied" };
    return current.leaseActive ? { status: "lease_held", record: parsed } : { status: "reconciliation_required", record: parsed };
  }

  async renewLease({ owner, leaseDurationMs }: RenewSessionAuthenticationLeaseInput): Promise<RenewSessionAuthenticationLeaseResult> {
    assertLease(owner.ownerToken, leaseDurationMs);
    const rows = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "leaseExpiresAt" = NOW() + (${leaseDurationMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (rows[0]) return { status: "lease_renewed", record: record(rows[0]) };
    const state = await this.ownerState(owner); return state.status === "current" ? { status: "not_applied" } : state;
  }

  async beginCredentialInteraction({ owner }: BeginCredentialInteractionInput): Promise<BeginCredentialInteractionResult> {
    const rows = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "interactionPhase" = 'credentials_may_have_reached_portal', "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() AND "interactionPhase" = 'no_credential_interaction' RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (rows[0]) return { status: "interaction_started", record: record(rows[0]) };
    const state = await this.ownerState(owner); return state.status === "current" ? { status: "already_started", record: state.record } : state;
  }

  async recordSubmitBarrier({ owner }: RecordSubmitBarrierInput): Promise<RecordSessionAuthenticationSubmitBarrierResult> {
    const rows = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "interactionPhase" = 'submit_may_have_been_dispatched', "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() AND "interactionPhase" = 'credentials_may_have_reached_portal' RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (rows[0]) return { status: "recorded", record: record(rows[0]) };
    const state = await this.ownerState(owner);
    if (state.status !== "current") return state;
    return state.record.interactionPhase === "submit_may_have_been_dispatched" ? { status: "already_recorded", record: state.record } : { status: "invalid_transition" };
  }

  async claimRetry({ owner }: ClaimRetryInput): Promise<ClaimSessionAuthenticationRetryResult> {
    const retry = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "retryCount" = "retryCount" + 1, "ownerToken" = NULL, "leaseExpiresAt" = NULL, "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() AND "interactionPhase" = 'no_credential_interaction' AND "retryCount" < 2 RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (retry[0]) { const current = record(retry[0]); return { status: "retry_claimed", retryCount: current.retryCount as 1 | 2, record: current }; }
    const exhausted = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "status" = 'failed', "failureClass" = 'transient_pre_interaction', "operatorReason" = 'temporary_authentication_problem', "ownerToken" = NULL, "leaseExpiresAt" = NULL, "terminalAt" = NOW(), "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() AND "interactionPhase" = 'no_credential_interaction' AND "retryCount" = 2 RETURNING "bankCode"`;
    if (exhausted[0]) return { status: "retry_exhausted" };
    const state = await this.ownerState(owner); return state.status === "current" ? state.record.interactionPhase === "no_credential_interaction" ? { status: "not_applied" } : { status: "ineligible" } : state;
  }

  async completeAuthenticated({ owner }: CompleteAuthenticatedInput): Promise<CompleteAuthenticatedResult> { return this.complete(owner, "authenticated"); }

  async completeFailed({ owner, failureClass, operatorReason }: CompleteFailedInput): Promise<CompleteFailedResult> {
    const permitted = (failureClass === "transient_pre_interaction" && operatorReason === "temporary_authentication_problem") || (failureClass === "protected_or_mfa" && operatorReason === "protected_authentication_step_detected") || ((failureClass === "incompatible_flow" || failureClass === "structural_configuration") && operatorReason === "bank_login_configuration_requires_review") || ((failureClass === "ownership_lost" || failureClass === "interaction_outcome_uncertain" || failureClass === "unclassified_failure") && operatorReason === "authentication_attempt_requires_review");
    if (!permitted) throw new Error("Invalid session authentication failure pair");
    const rows = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "status" = 'failed', "failureClass" = ${failureClass}, "operatorReason" = ${operatorReason}, "ownerToken" = NULL, "leaseExpiresAt" = NULL, "terminalAt" = NOW(), "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (rows[0]) return { status: "failed", record: record(rows[0]) };
    const state = await this.ownerState(owner); return state.status === "current" ? { status: "not_applied" } : state;
  }

  private async complete(owner: CompleteAuthenticatedInput["owner"], status: "authenticated"): Promise<CompleteAuthenticatedResult> {
    const rows = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "status" = ${status}, "ownerToken" = NULL, "leaseExpiresAt" = NULL, "terminalAt" = NOW(), "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (rows[0]) return { status: "authenticated", record: record(rows[0]) };
    const state = await this.ownerState(owner); return state.status === "current" ? { status: "not_applied" } : state;
  }

  async reconcileExpiredLease({ identity }: ReconcileExpiredLeaseInput): Promise<ReconcileExpiredLeaseResult> {
    const retry = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "retryCount" = "retryCount" + 1, "ownerToken" = NULL, "leaseExpiresAt" = NULL, "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${identity.bankCode} AND "runId" = ${identity.runId} AND "attemptId" = ${identity.attemptId} AND "status" = 'active' AND "ownerToken" IS NOT NULL AND "leaseExpiresAt" <= NOW() AND "interactionPhase" = 'no_credential_interaction' AND "retryCount" < 2 RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (retry[0]) return { status: "lease_reconciled", record: record(retry[0]) };
    const terminal = await this.prisma.$queryRaw<Row[]>`UPDATE "BankSessionAuthenticationAttempt" SET "status" = 'failed', "failureClass" = CASE WHEN "interactionPhase" = 'no_credential_interaction' THEN 'transient_pre_interaction' ELSE 'interaction_outcome_uncertain' END, "operatorReason" = CASE WHEN "interactionPhase" = 'no_credential_interaction' THEN 'temporary_authentication_problem' ELSE 'authentication_attempt_requires_review' END, "ownerToken" = NULL, "leaseExpiresAt" = NULL, "terminalAt" = NOW(), "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${identity.bankCode} AND "runId" = ${identity.runId} AND "attemptId" = ${identity.attemptId} AND "status" = 'active' AND "ownerToken" IS NOT NULL AND "leaseExpiresAt" <= NOW() AND (("interactionPhase" = 'no_credential_interaction' AND "retryCount" = 2) OR "interactionPhase" IN ('credentials_may_have_reached_portal', 'submit_may_have_been_dispatched')) RETURNING "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt"`;
    if (terminal[0]) return { status: "lease_reconciled", record: record(terminal[0]) };
    return { status: "not_applied" };
  }

  async resolveObservedRestoration(owner: SessionAuthenticationLeaseOwner, retry = true): Promise<ResolveObservedRestorationResult> {
    assertObservedOwner(owner);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const attempts = await tx.$queryRaw<Array<Row & { leaseActive: boolean }>>`SELECT "bankCode", "runId", "attemptId", "status", "interactionPhase", "failureClass", "operatorReason", "retryCount", "ownerToken", "generation", "leaseExpiresAt", "terminalAt", "createdAt", "updatedAt", COALESCE("leaseExpiresAt" > NOW(), FALSE) AS "leaseActive" FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} FOR UPDATE`;
        const attempt = attempts[0];
        if (!attempt) return { status: "missing", missing: "authentication_attempt" };
        if (attempt.attemptId !== owner.identity.attemptId) return { status: "identity_mismatch" };
        if (attempt.status !== "active") {
          if (attempt.status !== "authenticated") return { status: "terminal_conflict" };
          const episode = (await tx.$queryRaw<Array<{ runId: string; consumerAttemptState: string | null }>>`SELECT "runId", "consumerAttemptState" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${owner.identity.bankCode} FOR UPDATE`)[0];
          if (!episode) return { status: "already_resolved" };
          if (episode.runId !== owner.identity.runId) return { status: "identity_mismatch" };
          return episode.consumerAttemptState === "resolved" ? { status: "already_resolved" } : { status: "terminal_conflict" };
        }
        if (attempt.ownerToken !== owner.ownerToken || attempt.generation !== owner.generation) return { status: "stale_owner" };
        if (!attempt.leaseActive) return { status: "lease_expired" };
        const episode = (await tx.$queryRaw<Array<{ runId: string; consumerAttemptState: string | null; consumerClaimToken: string | null; consumerLeaseExpiresAt: Date | null; leaseActive: boolean }>>`SELECT "runId", "consumerAttemptState", "consumerClaimToken", "consumerLeaseExpiresAt", COALESCE("consumerLeaseExpiresAt" > NOW(), FALSE) AS "leaseActive" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${owner.identity.bankCode} FOR UPDATE`)[0];
        if (!episode) return { status: "missing", missing: "expiry_episode" };
        if (episode.runId !== owner.identity.runId) return { status: "identity_mismatch" };
        const mutation = episode.consumerAttemptState === "mutation_started";
        if (mutation && (!episode.consumerClaimToken || !episode.consumerLeaseExpiresAt || episode.leaseActive)) return { status: "active_mutation_owner" };
        if (episode.consumerAttemptState !== "manual_recovery_required" && !mutation) return { status: "episode_not_resolvable" };
        const authenticated = await tx.$queryRaw<Array<{ terminalAt: Date }>>`UPDATE "BankSessionAuthenticationAttempt" SET "status" = 'authenticated', "ownerToken" = NULL, "leaseExpiresAt" = NULL, "terminalAt" = NOW(), "generation" = "generation" + 1, "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "attemptId" = ${owner.identity.attemptId} AND "status" = 'active' AND "ownerToken" = ${owner.ownerToken} AND "generation" = ${owner.generation} AND "leaseExpiresAt" > NOW() RETURNING "terminalAt"`;
        if (authenticated.length !== 1) throw new Error("Observed restoration authentication CAS lost");
        const resolved = await tx.$executeRaw`UPDATE "BankSessionExpiryEpisode" SET "consumerAttemptState" = 'resolved', "consumerLeaseExpiresAt" = NULL, "updatedAt" = NOW() WHERE "bankCode" = ${owner.identity.bankCode} AND "runId" = ${owner.identity.runId} AND "consumerAttemptState" IN ('manual_recovery_required', 'mutation_started')`;
        if (resolved !== 1) throw new Error("Observed restoration expiry CAS lost");
        return { status: "resolved", evidence: { authenticatedAt: authenticated[0].terminalAt } };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (retry && (code === "P2034" || code === "40001" || /40001|serialize access/.test(String(error)))) return this.resolveObservedRestoration(owner, false);
      throw error;
    }
  }
}
