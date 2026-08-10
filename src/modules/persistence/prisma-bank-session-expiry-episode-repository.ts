import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { ManualRecoveryResolutionCommand, ManualRecoveryResolutionResult } from "../bank-sessions/manual-recovery-resolution";
import { createManualRecoveryReplayAuthorizedAudit, type ManualRecoveryReplayAuthorizationCandidate, type ManualRecoveryReplayAuthorizationRepository, type ManualRecoveryReplayAuthorizationResult } from "../bank-sessions/manual-recovery-replay-authorization";
import { createExpiryTerminalAudit, type ExpiryTerminalFailureReason, type ExpiryTerminalReconciliationRepository, type ExpiryTerminalReconciliationResult } from "../bank-sessions/expiry-terminal-reconciliation";
import { PUBLICATION_CLAIM_TIMEOUT_MS, assertConsumerClaimToken, consumerAttemptTransitions, parseConsumerAttemptLease, parseConsumerAttemptState, parseEpisodePublicationState, type ConsumerAttemptLeaseClaim, type ConsumerAttemptTransition } from "../bank-sessions/expiry-episodes";
import type {
  BankSessionExpiryEpisode,
  BankSessionExpiryEpisodeRepository,
  CreateBankSessionExpiryEpisodeInput,
  EpisodeCloseResult,
  ExpiryPublicationEnvelope,
  GetOrCreateBankSessionExpiryEpisodeResult,
  SessionEpisodeAuditKind,
} from "../bank-sessions/expiry-episodes";

type EpisodeRow = {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  expiredAuditDeliveredAt: Date | null;
  restoredAuditDeliveredAt: Date | null;
  publicationState: string;
  publicationClaimToken: string | null;
  publicationFailureReportedAt: Date | null;
  consumerClaimToken: string | null;
  consumerAttemptState: string | null;
  consumerAttemptSource: string | null;
  consumerLeaseExpiresAt: Date | null;
  terminalFailureReason: ExpiryTerminalFailureReason | null;
  terminalFailureReconciledAt: Date | null;
  updatedAt: Date;
};

function mapRow(row: EpisodeRow): BankSessionExpiryEpisode {
  const publicationState = parseEpisodePublicationState(row.publicationState, row.publicationClaimToken, row.publicationFailureReportedAt);
  const consumerAttemptState = parseConsumerAttemptState(row.consumerAttemptState, row.consumerClaimToken);
  const lease = parseConsumerAttemptLease(row.consumerAttemptSource, row.consumerLeaseExpiresAt, consumerAttemptState, publicationState, row.publicationClaimToken, row.terminalFailureReason);
  return {
    bankCode: row.bankCode,
    expiredEventId: row.expiredEventId,
    runId: row.runId,
    expiredAuditDelivered: row.expiredAuditDeliveredAt !== null,
    restoredAuditDelivered: row.restoredAuditDeliveredAt !== null,
    publicationState,
    publicationClaimToken: row.publicationClaimToken,
    publicationFailureReportedAt: row.publicationFailureReportedAt,
    consumerClaimToken: row.consumerClaimToken,
    terminalFailureReason: row.terminalFailureReason,
    terminalFailureReconciledAt: row.terminalFailureReconciledAt,
    consumerAttemptState,
    consumerAttemptSource: lease.source,
    consumerLeaseExpiresAt: lease.leaseExpiresAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaBankSessionExpiryEpisodeRepository implements BankSessionExpiryEpisodeRepository, ManualRecoveryReplayAuthorizationRepository, ExpiryTerminalReconciliationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async reconcileTerminalFailure(envelope: ExpiryPublicationEnvelope, reason: ExpiryTerminalFailureReason, reconciledAt: Date, retry = true): Promise<ExpiryTerminalReconciliationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<EpisodeRow & { activeLease: boolean }>>`SELECT "bankCode", "expiredEventId", "runId", "publicationState", "publicationClaimToken", "restoredAuditDeliveredAt", "consumerAttemptState", "consumerAttemptSource", "consumerLeaseExpiresAt", "terminalFailureReason", ("consumerLeaseExpiresAt" > NOW()) AS "activeLease" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${envelope.bankCode} AND "expiredEventId" = ${envelope.expiredEventId} AND "runId" = ${envelope.runId} AND "publicationState" = 'published' AND "publicationClaimToken" = ${envelope.token} AND "restoredAuditDeliveredAt" IS NULL AND "consumerAttemptState" IS DISTINCT FROM 'resolved' FOR UPDATE`;
        const episode = rows[0];
        if (!episode || !envelope.token.trim()) return { status: "ignored_stale_envelope", operatorSignal: "Automatic session recovery requires administrative review" };
        const strongerReason = episode.terminalFailureReason === "job_missing" && reason === "job_failed";
        if (episode.terminalFailureReason === "job_failed" || (episode.terminalFailureReason === "job_missing" && !strongerReason)) return { status: "already_reconciled", operatorSignal: "Automatic session recovery requires administrative review" };
        if (episode.terminalFailureReason !== null && !strongerReason) return { status: "ignored_stale_envelope", operatorSignal: "Automatic session recovery requires administrative review" };
        if (episode.activeLease) return { status: "deferred_active_lease", operatorSignal: "Automatic session recovery requires administrative review" };
        const requiresManualRecovery = episode.consumerAttemptState === "mutation_started" || episode.consumerAttemptState === "manual_recovery_required" || (episode.consumerAttemptSource !== null && episode.consumerAttemptState === "reserved");
        const updated = await tx.$queryRaw<{ bankCode: string }[]>`UPDATE "BankSessionExpiryEpisode" SET "terminalFailureReason" = ${reason}, "terminalFailureReconciledAt" = ${reconciledAt}, "consumerAttemptState" = CASE WHEN "consumerAttemptState" = 'mutation_started' OR ("consumerAttemptSource" IS NOT NULL AND "consumerAttemptState" = 'reserved') THEN 'manual_recovery_required' ELSE "consumerAttemptState" END, "consumerLeaseExpiresAt" = CASE WHEN "consumerAttemptState" = 'mutation_started' OR ("consumerAttemptSource" IS NOT NULL AND "consumerAttemptState" = 'reserved') THEN NULL ELSE "consumerLeaseExpiresAt" END, "updatedAt" = NOW() WHERE "bankCode" = ${envelope.bankCode} AND "expiredEventId" = ${envelope.expiredEventId} AND "runId" = ${envelope.runId} AND "publicationState" = 'published' AND "publicationClaimToken" = ${envelope.token} AND "restoredAuditDeliveredAt" IS NULL AND "consumerAttemptState" IS DISTINCT FROM 'resolved' AND (${episode.terminalFailureReason}::text IS NULL OR ("terminalFailureReason" = 'job_missing' AND ${reason} = 'job_failed')) RETURNING "bankCode"`;
        if (!updated[0]) return { status: "ignored_stale_envelope", operatorSignal: "Automatic session recovery requires administrative review" };
        const audit = createExpiryTerminalAudit(envelope, reason, reconciledAt, requiresManualRecovery);
        await tx.auditEvent.upsert({ where: { id: audit.id }, create: { ...audit, metadata: (audit.metadata as Prisma.InputJsonValue | null) ?? undefined }, update: { action: audit.action, target: audit.target, targetId: audit.targetId, metadata: (audit.metadata as Prisma.InputJsonValue | null) ?? undefined, createdAt: audit.createdAt } });
        return { status: "reconciled", operatorSignal: "Automatic session recovery requires administrative review", audit };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
      if (retry && (code === "P2034" || code === "40001" || /40001|serialize access/.test(String(error)))) return this.reconcileTerminalFailure(envelope, reason, reconciledAt, false);
      throw error;
    }
  }

  async findManualRecoveryReplayBankCode(resolutionId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ bankCode: string }[]>`SELECT "bankCode" FROM "ManualRecoveryResolution" WHERE "id" = ${resolutionId}`;
    return rows[0]?.bankCode ?? null;
  }

  async authorizeManualRecoveryReplay(candidate: ManualRecoveryReplayAuthorizationCandidate, retry = true): Promise<ManualRecoveryReplayAuthorizationResult> {
    type Resolution = { id: string; bankCode: string; expiredEventId: string; runId: string; operatorId: string; outcome: string; reason: string; replayExpiredEventId: string | null; replayRunId: string | null; replayAuthorizedAt: Date | null; state: string; deliveredAt: Date | null };
    const result = (status: "authorized" | "already_authorized", resolution: Resolution): ManualRecoveryReplayAuthorizationResult => {
      const audit = createManualRecoveryReplayAuthorizedAudit(resolution.id, resolution.operatorId, resolution.replayExpiredEventId!, resolution.replayRunId!, resolution.replayAuthorizedAt!);
      return { status, replayExpiredEventId: resolution.replayExpiredEventId!, replayRunId: resolution.replayRunId!, audit };
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Resolution[]>`
          SELECT r."id", r."bankCode", r."expiredEventId", r."runId", r."operatorId", r."outcome", r."reason", r."replayExpiredEventId", r."replayRunId", r."replayAuthorizedAt", o."state", o."deliveredAt"
          FROM "ManualRecoveryResolution" r JOIN "ManualRecoveryResolutionAuditOutbox" o ON o."resolutionId" = r."id" WHERE r."id" = ${candidate.resolutionId} FOR UPDATE OF r, o
        `;
        const resolution = rows[0];
        if (!resolution || resolution.outcome !== "safe_to_retry" || resolution.reason !== "verified_no_mutation" || resolution.state !== "delivered" || !resolution.deliveredAt) return { status: "ineligible" };
        if (resolution.replayExpiredEventId && resolution.replayRunId && resolution.replayAuthorizedAt) return result("already_authorized", resolution);
        if (!candidate.replayExpiredEventId.trim() || !candidate.replayRunId.trim() || candidate.replayExpiredEventId === candidate.replayRunId || candidate.replayExpiredEventId === resolution.expiredEventId || candidate.replayRunId === resolution.runId) throw new Error("Replay IDs must be nonblank and different");
        const conflicts = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ManualRecoveryResolution" WHERE "expiredEventId" = ${candidate.replayExpiredEventId} OR "runId" = ${candidate.replayRunId} OR "replayExpiredEventId" = ${candidate.replayExpiredEventId} OR "replayRunId" = ${candidate.replayRunId} FOR UPDATE`;
        if (conflicts[0]) throw new Error("Replay IDs conflict with durable identity");
        const episodes = await tx.$queryRaw<EpisodeRow[]>`SELECT "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptState", "terminalFailureReason", "terminalFailureReconciledAt", "updatedAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${resolution.bankCode} FOR UPDATE`;
        const episode = episodes[0];
        if (episode && (episode.expiredEventId !== resolution.expiredEventId || episode.runId !== resolution.runId || episode.publicationState !== "published" || episode.consumerAttemptState !== "resolved")) return { status: "ineligible" };
        const updated = await tx.$queryRaw<{ id: string }[]>`UPDATE "ManualRecoveryResolution" r SET "replayExpiredEventId" = ${candidate.replayExpiredEventId}, "replayRunId" = ${candidate.replayRunId}, "replayAuthorizedAt" = ${candidate.authorizedAt} FROM "ManualRecoveryResolutionAuditOutbox" o WHERE r."id" = ${resolution.id} AND o."resolutionId" = r."id" AND r."outcome" = 'safe_to_retry' AND r."reason" = 'verified_no_mutation' AND o."state" = 'delivered' AND o."deliveredAt" IS NOT NULL AND r."replayExpiredEventId" IS NULL AND r."replayRunId" IS NULL AND r."replayAuthorizedAt" IS NULL RETURNING r."id"`;
        if (!updated[0]) throw new Error("Replay authorization CAS lost");
        if (episode && await tx.$executeRaw`DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${resolution.bankCode} AND "expiredEventId" = ${resolution.expiredEventId} AND "runId" = ${resolution.runId} AND "publicationState" = 'published' AND "consumerAttemptState" = 'resolved'` !== 1) throw new Error("Replay authorization episode CAS lost");
        await tx.$executeRaw`INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "updatedAt") VALUES (${resolution.bankCode}, ${candidate.replayExpiredEventId}, ${candidate.replayRunId}, NOW())`;
        const authorized = { ...resolution, replayExpiredEventId: candidate.replayExpiredEventId, replayRunId: candidate.replayRunId, replayAuthorizedAt: candidate.authorizedAt };
        const audit = result("authorized", authorized).audit!;
        await tx.auditEvent.create({ data: { ...audit, metadata: (audit.metadata as Prisma.InputJsonValue | null) ?? undefined } });
        return { status: "authorized", replayExpiredEventId: candidate.replayExpiredEventId, replayRunId: candidate.replayRunId, audit };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
      const serializationFailure = code === "P2034" || code === "40001" || /40001|serialize access/.test(String(error));
      if (!["P2002", "23505"].includes(code ?? "") && !serializationFailure) throw error;
      const rows = await this.prisma.$queryRaw<Resolution[]>`SELECT r."id", r."bankCode", r."expiredEventId", r."runId", r."operatorId", r."outcome", r."reason", r."replayExpiredEventId", r."replayRunId", r."replayAuthorizedAt", o."state", o."deliveredAt" FROM "ManualRecoveryResolution" r JOIN "ManualRecoveryResolutionAuditOutbox" o ON o."resolutionId" = r."id" WHERE r."id" = ${candidate.resolutionId}`;
      if (rows[0]?.replayExpiredEventId && rows[0].replayRunId && rows[0].replayAuthorizedAt) return result("already_authorized", rows[0]);
      if (serializationFailure && retry) return this.authorizeManualRecoveryReplay(candidate, false);
      throw error;
    }
  }
  async getOrCreate(input: CreateBankSessionExpiryEpisodeInput): Promise<GetOrCreateBankSessionExpiryEpisodeResult> {
    const inserted = await this.prisma.$queryRaw<EpisodeRow[]>`
      INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "updatedAt")
      VALUES (${input.bankCode}, ${input.expiredEventId}, ${input.runId}, NOW())
      ON CONFLICT ("bankCode") DO NOTHING
      RETURNING "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptState", "consumerAttemptSource", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt", "updatedAt"
    `;
    if (inserted[0]) return { episode: mapRow(inserted[0]), created: true };

    const existing = await this.prisma.$queryRaw<EpisodeRow[]>`
      SELECT "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptState", "consumerAttemptSource", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt", "updatedAt"
      FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${input.bankCode}
    `;
    if (!existing[0]) throw new Error("Bank session expiry episode was not available after insert conflict");
    return { episode: mapRow(existing[0]), created: false };
  }

  async findByBankCode(bankCode: string): Promise<BankSessionExpiryEpisode | null> {
    const rows = await this.prisma.$queryRaw<EpisodeRow[]>`
      SELECT "bankCode", "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptState", "consumerAttemptSource", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt", "updatedAt"
      FROM "BankSessionExpiryEpisode" WHERE "bankCode" = ${bankCode}
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async claimPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    parseEpisodePublicationState("publishing", token, null);
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      UPDATE "BankSessionExpiryEpisode" SET "publicationState" = 'publishing', "publicationClaimToken" = ${token}, "publicationFailureReportedAt" = NULL, "updatedAt" = NOW()
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId}
        AND "restoredAuditDeliveredAt" IS NULL
        AND "consumerAttemptState" IS NULL
        AND (
          "publicationState" = 'pending'
          OR (
            "publicationState" = 'publishing' AND "publicationClaimToken" = ${token}
            AND ("publicationFailureReportedAt" IS NOT NULL OR "updatedAt" < NOW() - (${PUBLICATION_CLAIM_TIMEOUT_MS} * INTERVAL '1 millisecond'))
          )
        )
      RETURNING "bankCode"
    `;
    return updated.length === 1;
  }

  async markPublicationPublished(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    parseEpisodePublicationState("published", token, null);
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      UPDATE "BankSessionExpiryEpisode" SET "publicationState" = 'published', "publicationFailureReportedAt" = NULL, "updatedAt" = NOW()
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId}
        AND "restoredAuditDeliveredAt" IS NULL AND "publicationState" = 'publishing' AND "publicationClaimToken" = ${token} RETURNING "bankCode"
    `;
    return updated.length === 1;
  }
  async cancelPublication(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<boolean> {
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      UPDATE "BankSessionExpiryEpisode" SET "publicationState" = 'cancelled', "publicationClaimToken" = NULL, "publicationFailureReportedAt" = NULL, "updatedAt" = NOW()
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId}
        AND "publicationState" IN ('pending', 'publishing') RETURNING "bankCode"
    `;
    return updated.length === 1;
  }

  async markPublicationFailureReported(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">, token: string): Promise<boolean> {
    parseEpisodePublicationState("publishing", token, null);
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      UPDATE "BankSessionExpiryEpisode" SET "publicationFailureReportedAt" = NOW(), "updatedAt" = NOW()
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId}
        AND "publicationState" = 'publishing' AND "publicationClaimToken" = ${token} AND "publicationFailureReportedAt" IS NULL
      RETURNING "bankCode"
    `;
    return updated.length === 1;
  }

  async claimConsumerAttempt(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    assertConsumerClaimToken(consumerClaimToken);
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = ${consumerClaimToken}, "consumerAttemptState" = 'reserved', "updatedAt" = NOW()
      WHERE "bankCode" = ${envelope.bankCode} AND "expiredEventId" = ${envelope.expiredEventId} AND "runId" = ${envelope.runId}
        AND "publicationClaimToken" = ${envelope.token} AND "publicationState" = 'published'
        AND "restoredAuditDeliveredAt" IS NULL AND "consumerClaimToken" IS NULL AND "consumerAttemptState" IS NULL
      RETURNING "bankCode"
    `;
    return updated.length === 1;
  }
  async claimConsumerAttemptLease(claim: ConsumerAttemptLeaseClaim): Promise<boolean> {
    assertConsumerClaimToken(claim.consumerClaimToken); if (!Number.isFinite(claim.leaseDurationMs) || claim.leaseDurationMs <= 0) throw new Error("Consumer lease duration must be positive and finite");
    if (claim.source === "scheduled") {
      const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = ${claim.consumerClaimToken}, "consumerAttemptState" = 'reserved', "consumerAttemptSource" = 'scheduled', "consumerLeaseExpiresAt" = NOW() + (${claim.leaseDurationMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "bankCode" = ${claim.envelope.bankCode} AND "expiredEventId" = ${claim.envelope.expiredEventId} AND "runId" = ${claim.envelope.runId} AND "publicationState" = 'published' AND "publicationClaimToken" = ${claim.envelope.token} AND "restoredAuditDeliveredAt" IS NULL AND "consumerClaimToken" IS NULL AND "consumerAttemptState" IS NULL AND "terminalFailureReason" IS NULL RETURNING "bankCode"`;
      return updated.length === 1;
    }
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`UPDATE "BankSessionExpiryEpisode" SET "consumerClaimToken" = ${claim.consumerClaimToken}, "consumerAttemptState" = 'reserved', "consumerAttemptSource" = 'scrape_time', "consumerLeaseExpiresAt" = NOW() + (${claim.leaseDurationMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "bankCode" = ${claim.episode.bankCode} AND "expiredEventId" = ${claim.episode.expiredEventId} AND "runId" = ${claim.episode.runId} AND "publicationState" = 'pending' AND "publicationClaimToken" IS NULL AND "restoredAuditDeliveredAt" IS NULL AND "consumerClaimToken" IS NULL AND "consumerAttemptState" IS NULL AND "terminalFailureReason" IS NULL RETURNING "bankCode"`;
    return updated.length === 1;
  }
  async renewConsumerAttemptLease(claim: ConsumerAttemptLeaseClaim): Promise<boolean> {
    assertConsumerClaimToken(claim.consumerClaimToken); if (!Number.isFinite(claim.leaseDurationMs) || claim.leaseDurationMs <= 0) throw new Error("Consumer lease duration must be positive and finite");
    if (claim.source === "scheduled") {
      const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`UPDATE "BankSessionExpiryEpisode" SET "consumerLeaseExpiresAt" = NOW() + (${claim.leaseDurationMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "bankCode" = ${claim.envelope.bankCode} AND "expiredEventId" = ${claim.envelope.expiredEventId} AND "runId" = ${claim.envelope.runId} AND "publicationState" = 'published' AND "publicationClaimToken" = ${claim.envelope.token} AND "consumerClaimToken" = ${claim.consumerClaimToken} AND "consumerAttemptSource" = 'scheduled' AND "consumerAttemptState" IN ('reserved', 'mutation_started') AND "terminalFailureReason" IS NULL AND "consumerLeaseExpiresAt" > NOW() RETURNING "bankCode"`;
      return updated.length === 1;
    }
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`UPDATE "BankSessionExpiryEpisode" SET "consumerLeaseExpiresAt" = NOW() + (${claim.leaseDurationMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "bankCode" = ${claim.episode.bankCode} AND "expiredEventId" = ${claim.episode.expiredEventId} AND "runId" = ${claim.episode.runId} AND "publicationState" = 'pending' AND "publicationClaimToken" IS NULL AND "consumerClaimToken" = ${claim.consumerClaimToken} AND "consumerAttemptSource" = 'scrape_time' AND "consumerAttemptState" IN ('reserved', 'mutation_started') AND "terminalFailureReason" IS NULL AND "consumerLeaseExpiresAt" > NOW() RETURNING "bankCode"`;
    return updated.length === 1;
  }
  async markConsumerMutationStarted(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    return this.transitionConsumerAttempt(envelope, consumerClaimToken, consumerAttemptTransitions.mutationStarted);
  }
  async markConsumerManualRecoveryRequired(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    return this.transitionConsumerAttempt(envelope, consumerClaimToken, consumerAttemptTransitions.manualRecoveryRequired);
  }
  async markConsumerResolved(envelope: ExpiryPublicationEnvelope, consumerClaimToken: string): Promise<boolean> {
    assertConsumerClaimToken(consumerClaimToken);
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`UPDATE "BankSessionExpiryEpisode" SET "consumerAttemptState" = 'resolved', "consumerLeaseExpiresAt" = NULL, "updatedAt" = NOW() WHERE "bankCode" = ${envelope.bankCode} AND "expiredEventId" = ${envelope.expiredEventId} AND "runId" = ${envelope.runId} AND "publicationState" = 'published' AND "publicationClaimToken" = ${envelope.token} AND "consumerClaimToken" = ${consumerClaimToken} AND ("consumerLeaseExpiresAt" IS NULL OR "consumerLeaseExpiresAt" > NOW()) AND ("consumerAttemptState" = 'mutation_started' OR ("consumerAttemptState" = 'reserved' AND "restoredAuditDeliveredAt" IS NULL)) RETURNING "bankCode"`;
    return updated.length === 1;
  }
  async resolveConsumerManualRecovery(
    envelope: ExpiryPublicationEnvelope,
    consumerClaimToken: string,
    command: ManualRecoveryResolutionCommand,
  ): Promise<ManualRecoveryResolutionResult | null> {
    assertConsumerClaimToken(consumerClaimToken);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw<{ bankCode: string; expiredEventId: string; runId: string }[]>`
          UPDATE "BankSessionExpiryEpisode"
          SET "consumerAttemptState" = 'resolved', "updatedAt" = NOW()
          WHERE "bankCode" = ${envelope.bankCode}
            AND "expiredEventId" = ${envelope.expiredEventId}
            AND "runId" = ${envelope.runId}
            AND "publicationClaimToken" = ${envelope.token}
            AND "publicationState" = 'published'
            AND "consumerClaimToken" = ${consumerClaimToken}
            AND "consumerAttemptState" = 'manual_recovery_required'
          RETURNING "bankCode", "expiredEventId", "runId"
        `;
        if (!claimed[0]) return null;

        const resolution = await tx.manualRecoveryResolution.create({
          data: {
            expiredEventId: claimed[0].expiredEventId,
            bankCode: claimed[0].bankCode,
            runId: claimed[0].runId,
            outcome: command.decision.outcome,
            reason: command.decision.reason,
            operatorId: command.operatorId,
          },
        });
        await tx.manualRecoveryResolutionAuditOutbox.create({ data: { resolutionId: resolution.id } });
        return {
          id: resolution.id,
          bankCode: resolution.bankCode,
          expiredEventId: resolution.expiredEventId,
          runId: resolution.runId,
          decision: command.decision,
          operatorId: resolution.operatorId,
          resolvedAt: resolution.resolvedAt,
        };
      });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "23505")
      ) return null;
      throw error;
    }
  }
  async isAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const rows = kind === "expired"
      ? await this.prisma.$queryRaw<{ deliveredAt: Date | null }[]>`
          SELECT "expiredAuditDeliveredAt" AS "deliveredAt" FROM "BankSessionExpiryEpisode"
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId}
        `
      : await this.prisma.$queryRaw<{ deliveredAt: Date | null }[]>`
          SELECT "restoredAuditDeliveredAt" AS "deliveredAt" FROM "BankSessionExpiryEpisode"
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId}
        `;
    return rows[0]?.deliveredAt !== null && rows[0] !== undefined;
  }

  async markAuditDelivered(
    episode: Pick<BankSessionExpiryEpisode, "bankCode" | "runId">,
    kind: SessionEpisodeAuditKind,
  ): Promise<boolean> {
    const updated = kind === "expired"
      ? await this.prisma.$queryRaw<{ bankCode: string }[]>`
          UPDATE "BankSessionExpiryEpisode" SET "expiredAuditDeliveredAt" = NOW(), "updatedAt" = NOW()
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId} AND "expiredAuditDeliveredAt" IS NULL
          RETURNING "bankCode"
        `
      : await this.prisma.$queryRaw<{ bankCode: string }[]>`
           UPDATE "BankSessionExpiryEpisode" SET "restoredAuditDeliveredAt" = NOW(),
             "consumerClaimToken" = CASE WHEN "consumerAttemptState" = 'reserved' THEN NULL ELSE "consumerClaimToken" END,
             "consumerAttemptState" = CASE WHEN "consumerAttemptState" = 'reserved' THEN NULL ELSE "consumerAttemptState" END,
             "consumerAttemptSource" = CASE WHEN "consumerAttemptState" = 'reserved' THEN NULL ELSE "consumerAttemptSource" END,
             "consumerLeaseExpiresAt" = CASE WHEN "consumerAttemptState" = 'reserved' THEN NULL ELSE "consumerLeaseExpiresAt" END,
            "updatedAt" = NOW()
          WHERE "bankCode" = ${episode.bankCode} AND "runId" = ${episode.runId} AND "restoredAuditDeliveredAt" IS NULL
          RETURNING "bankCode"
        `;
    return updated.length === 1;
  }

  async close(episode: Pick<BankSessionExpiryEpisode, "bankCode" | "expiredEventId" | "runId">): Promise<EpisodeCloseResult> {
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "BankSessionExpiryEpisode"
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId} AND ("consumerAttemptState" IS NULL OR "consumerAttemptState" = 'resolved')
    `;
    if (deleted === 1) return "closed";
    const retained = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      SELECT "bankCode" FROM "BankSessionExpiryEpisode"
      WHERE "bankCode" = ${episode.bankCode} AND "expiredEventId" = ${episode.expiredEventId} AND "runId" = ${episode.runId} AND "consumerAttemptState" IS NOT NULL AND "consumerAttemptState" <> 'resolved'
    `;
    return retained[0] ? "retained_for_recovery" : "missing_or_stale";
  }

  private async transitionConsumerAttempt(
    envelope: ExpiryPublicationEnvelope,
    consumerClaimToken: string,
    transition: ConsumerAttemptTransition,
  ): Promise<boolean> {
    assertConsumerClaimToken(consumerClaimToken);
    const updated = await this.prisma.$queryRaw<{ bankCode: string }[]>`
      UPDATE "BankSessionExpiryEpisode" SET "consumerAttemptState" = ${transition.to}, "consumerLeaseExpiresAt" = CASE WHEN ${transition.to} = 'manual_recovery_required' THEN NULL ELSE "consumerLeaseExpiresAt" END, "updatedAt" = NOW()
      WHERE "bankCode" = ${envelope.bankCode} AND "expiredEventId" = ${envelope.expiredEventId} AND "runId" = ${envelope.runId}
        AND "publicationClaimToken" = ${envelope.token} AND "publicationState" = 'published'
        AND "consumerClaimToken" = ${consumerClaimToken} AND "consumerAttemptState" = ${transition.from}
        AND ("consumerLeaseExpiresAt" IS NULL OR "consumerLeaseExpiresAt" > NOW())
        AND (${transition.requiresUnrestored} = FALSE OR "restoredAuditDeliveredAt" IS NULL)
      RETURNING "bankCode"
    `;
    return updated.length === 1;
  }

}
