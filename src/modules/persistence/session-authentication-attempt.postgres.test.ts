import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../../generated/prisma/client";
import type { SessionAuthenticationAttemptRecord } from "../bank-sessions/session-authentication-attempt-repository";
import { PrismaBankSessionAuthenticationAttemptRepository } from "./prisma-bank-session-authentication-attempt-repository";

const url = process.env.RD_SYNC_TEST_DATABASE_URL;
const pool = url ? new Pool({ connectionString: url }) : undefined;
const prisma = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : undefined;
const attemptIdentity = (name: string, attemptId = "attempt") => ({ bankCode: "auth-contract-bank", runId: name, attemptId });

describe.skipIf(!url)("Session authentication attempt PostgreSQL contract", () => {
  beforeEach(async () => {
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" LIKE \'auth-contract-%\'');
    await pool!.query('DELETE FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" LIKE \'auth-contract-%\'');
    await pool!.query('DELETE FROM "Bank" WHERE "code" LIKE \'auth-contract-%\'');
    await pool!.query('INSERT INTO "Bank" ("id", "code", "name", "updatedAt") VALUES ($1, $2, $3, NOW())', ["auth-contract-bank-id", "auth-contract-bank", "Authentication contract bank"]);
    const checks = await pool!.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid = '\"BankSessionAuthenticationAttempt\"'::regclass AND contype = 'c'");
    expect(checks.rows.map(({ conname }) => conname)).toEqual(expect.arrayContaining([
      "BankSessionAuthenticationAttempt_identity_check", "BankSessionAuthenticationAttempt_status_check",
      "BankSessionAuthenticationAttempt_phase_check", "BankSessionAuthenticationAttempt_retry_check",
      "BankSessionAuthenticationAttempt_generation_check", "BankSessionAuthenticationAttempt_owner_check",
      "BankSessionAuthenticationAttempt_terminal_check",
    ]));
  });

  afterAll(async () => { await pool?.end(); await prisma?.$disconnect(); });
  const repo = () => new PrismaBankSessionAuthenticationAttemptRepository(prisma!);
  async function lease(name: string, token = "owner") {
    const id = attemptIdentity(name); await repo().getOrCreate({ identity: id });
    const result = await repo().acquireLease({ identity: id, ownerToken: token, leaseDurationMs: 10_000 });
    if (result.status !== "lease_acquired") throw new Error("Expected lease acquisition");
    return { id, owner: result.owner };
  }
  async function createBank(bankCode: string) {
    await pool!.query('INSERT INTO "Bank" ("id", "code", "name", "updatedAt") VALUES ($1, $2, $3, NOW())', [`${bankCode}-id`, bankCode, bankCode]);
  }
  async function expire(id: ReturnType<typeof attemptIdentity>) { await pool!.query('UPDATE "BankSessionAuthenticationAttempt" SET "leaseExpiresAt" = NOW() WHERE "bankCode" = $1 AND "runId" = $2 AND "attemptId" = $3', [id.bankCode, id.runId, id.attemptId]); }
  async function episode(id: ReturnType<typeof attemptIdentity>, state = "manual_recovery_required", lease = "NOW() - INTERVAL '1 second'") {
    const mutation = state === "mutation_started";
    await pool!.query(`INSERT INTO "BankSessionExpiryEpisode" ("bankCode", "expiredEventId", "runId", "publicationState", "publicationClaimToken", "consumerClaimToken", "consumerAttemptState", "consumerAttemptSource", "consumerLeaseExpiresAt", "updatedAt") VALUES ($1, $2, $3, ${mutation ? "'published', 'publication'" : "'pending', NULL"}, 'consumer', $4, ${mutation && lease !== "NULL" ? "'scheduled'" : "NULL"}, ${mutation ? lease : "NULL"}, NOW())`, [id.bankCode, `expired-${id.runId}`, id.runId, state]);
  }
  function diagnosticRow(record: SessionAuthenticationAttemptRecord) {
    return {
      bankCode: record.identity.bankCode, runId: record.identity.runId, attemptId: record.identity.attemptId,
      status: record.status, interactionPhase: record.interactionPhase, failureClass: record.failureClass,
      operatorReason: record.operatorReason, retryCount: record.retryCount, ownerToken: record.ownerToken,
      generation: record.generation, leaseExpiresAt: record.leaseExpiresAt, terminalAt: record.terminalAt,
      createdAt: record.createdAt, updatedAt: record.updatedAt, leaseActive: true,
    };
  }

  it("creates one exact tuple concurrently and reports creation once", async () => {
    const id = attemptIdentity("create"); const results = await Promise.all([repo().getOrCreate({ identity: id }), repo().getOrCreate({ identity: id })]);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(await repo().findExact({ identity: { ...id, attemptId: "other" } })).toEqual({ status: "missing" });
    expect((await repo().findExact({ identity: id })).status).toBe("found");
  });

  it("fails closed for a sequential different attempt identity without mutating the existing aggregate", async () => {
    const id = attemptIdentity("identity-conflict");
    await expect(repo().getOrCreate({ identity: id })).resolves.toMatchObject({ status: "created" });
    const acquired = await repo().acquireLease({ identity: id, ownerToken: "existing-owner", leaseDurationMs: 10_000 });
    if (acquired.status !== "lease_acquired") throw new Error("Expected lease acquisition");

    const conflict = await repo().getOrCreate({ identity: { ...id, attemptId: "different-attempt" } });
    expect(conflict).toEqual({ status: "identity_conflict", existingAttemptId: id.attemptId });
    expect(conflict).not.toHaveProperty("ownerToken");
    expect(conflict).not.toHaveProperty("record");
    await expect(repo().findExact({ identity: id })).resolves.toMatchObject({ status: "found", record: { retryCount: 0, generation: 1n, interactionPhase: "no_credential_interaction", ownerToken: "existing-owner" } });
    await expect(pool!.query('SELECT COUNT(*)::int AS count FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = $1 AND "runId" = $2', [id.bankCode, id.runId])).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("creates one aggregate and reports identity conflict for concurrent different attempt identities", async () => {
    const first = attemptIdentity("concurrent-identity-conflict", "first-attempt");
    const second = { ...first, attemptId: "second-attempt" };
    const results = await Promise.all([repo().getOrCreate({ identity: first }), repo().getOrCreate({ identity: second })]);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "identity_conflict")).toHaveLength(1);
    await expect(pool!.query('SELECT COUNT(*)::int AS count FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = $1 AND "runId" = $2', [first.bankCode, first.runId])).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("enforces aggregate uniqueness and restrictive bank references in PostgreSQL", async () => {
    const bankCode = "auth-contract-fk";
    await createBank(bankCode);
    await pool!.query('INSERT INTO "BankSessionAuthenticationAttempt" ("bankCode", "runId", "attemptId", "updatedAt") VALUES ($1, $2, $3, NOW())', [bankCode, "run", "first"]);
    await expect(pool!.query('INSERT INTO "BankSessionAuthenticationAttempt" ("bankCode", "runId", "attemptId", "retryCount", "updatedAt") VALUES ($1, $2, $3, 1, NOW())', [bankCode, "run", "second"])).rejects.toMatchObject({ code: "23505" });
    await expect(pool!.query('DELETE FROM "Bank" WHERE "code" = $1', [bankCode])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query('UPDATE "Bank" SET "code" = $2 WHERE "code" = $1', [bankCode, `${bankCode}-renamed`])).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects unknown bank codes through the foreign key", async () => {
    const id = { bankCode: "auth-contract-unknown-bank", runId: "run", attemptId: "attempt" };
    await expect(pool!.query('INSERT INTO "BankSessionAuthenticationAttempt" ("bankCode", "runId", "attemptId", "updatedAt") VALUES ($1, $2, $3, NOW())', [id.bankCode, id.runId, id.attemptId])).rejects.toMatchObject({ code: "23503" });
    await expect(repo().getOrCreate({ identity: id })).rejects.toBeDefined();
  });

  it("acquires once, fences generation, and renews only the exact active owner", async () => {
    const id = attemptIdentity("lease"); await repo().getOrCreate({ identity: id });
    const [first, second] = await Promise.all(["one", "two"].map((ownerToken) => repo().acquireLease({ identity: id, ownerToken, leaseDurationMs: 10_000 })));
    const acquired = [first, second].find((result) => result.status === "lease_acquired");
    expect([first, second].filter((result) => result.status === "lease_acquired")).toHaveLength(1);
    if (!acquired || acquired.status !== "lease_acquired") throw new Error("Expected acquired lease");
    expect(acquired.record).toMatchObject({ generation: 1n, retryCount: 0 });
    await expect(repo().renewLease({ owner: { ...acquired.owner, ownerToken: "wrong" }, leaseDurationMs: 10_000 })).resolves.toEqual({ status: "stale_owner" });
    await expire(id);
    await expect(repo().renewLease({ owner: acquired.owner, leaseDurationMs: 10_000 })).resolves.toEqual({ status: "lease_expired" });
  });

  it("requires reconciliation before replacing an expired owner and fences that owner afterward", async () => {
    const { id, owner: old } = await lease("expired-owner-acquire");
    await expire(id);
    const before = await repo().findExact({ identity: id });
    if (before.status !== "found" || before.record.status !== "active") throw new Error("Expected expired owned attempt");

    await expect(repo().acquireLease({ identity: id, ownerToken: "replacement", leaseDurationMs: 10_000 }))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    await expect(repo().findExact({ identity: id })).resolves.toEqual(before);

    await expect(repo().reconcileExpiredLease({ identity: id })).resolves.toMatchObject({
      status: "lease_reconciled", record: { ownerToken: null, leaseExpiresAt: null, retryCount: 1, generation: old.generation + 1n },
    });
    const replacement = await repo().acquireLease({ identity: id, ownerToken: "replacement", leaseDurationMs: 10_000 });
    if (replacement.status !== "lease_acquired") throw new Error("Expected replacement owner after reconciliation");
    expect(replacement.owner.generation).toBeGreaterThan(old.generation);
    await expect(repo().beginCredentialInteraction({ owner: old })).resolves.toEqual({ status: "stale_owner" });
  });

  it("does not label a failed renew CAS as expired when its diagnostic still sees an active current owner", async () => {
    const { owner } = await lease("renew-not-applied");
    const current = await repo().findExact({ identity: owner.identity });
    if (current.status !== "found" || current.record.status !== "active") throw new Error("Expected active attempt");
    const calls: unknown[] = [[], [diagnosticRow(current.record)]];
    const diagnosticRepo = new PrismaBankSessionAuthenticationAttemptRepository({ $queryRaw: async () => calls.shift() } as unknown as typeof prisma extends undefined ? never : NonNullable<typeof prisma>);
    await expect(diagnosticRepo.renewLease({ owner, leaseDurationMs: 10_000 })).resolves.toEqual({ status: "not_applied" });
  });

  it("preserves monotonic interaction and requires one recorded submit barrier", async () => {
    const { id, owner: current } = await lease("barrier");
    await expect(repo().recordSubmitBarrier({ owner: current })).resolves.toEqual({ status: "invalid_transition" });
    await expect(repo().beginCredentialInteraction({ owner: current })).resolves.toMatchObject({ status: "interaction_started" });
    await expect(repo().beginCredentialInteraction({ owner: current })).resolves.toMatchObject({ status: "already_started" });
    await expect(repo().recordSubmitBarrier({ owner: current })).resolves.toMatchObject({ status: "recorded" });
    await expect(repo().recordSubmitBarrier({ owner: current })).resolves.toMatchObject({ status: "already_recorded" });
    expect((await repo().findExact({ identity: id }))).toMatchObject({ status: "found", record: { interactionPhase: "submit_may_have_been_dispatched" } });
  });

  it("does not authorize a second submit barrier", async () => {
    const { owner } = await lease("second-submit");
    await repo().beginCredentialInteraction({ owner });
    await expect(repo().recordSubmitBarrier({ owner })).resolves.toMatchObject({ status: "recorded" });
    const second = await repo().recordSubmitBarrier({ owner });
    expect(second.status).toBe("already_recorded");
    expect(second.status === "recorded").toBe(false);
  });

  it("returns not_applied for ambiguous retry and completion diagnostics", async () => {
    const { owner } = await lease("diagnostic-not-applied");
    const current = await repo().findExact({ identity: owner.identity });
    if (current.status !== "found" || current.record.status !== "active") throw new Error("Expected active attempt");
    const currentDiagnosticRow = diagnosticRow(current.record);
    const fake = (responses: unknown[]) => new PrismaBankSessionAuthenticationAttemptRepository({ $queryRaw: async () => responses.shift() } as unknown as typeof prisma extends undefined ? never : NonNullable<typeof prisma>);
    await expect(fake([[], [], [currentDiagnosticRow]]).claimRetry({ owner })).resolves.toEqual({ status: "not_applied" });
    await expect(fake([[], [currentDiagnosticRow]]).completeAuthenticated({ owner })).resolves.toEqual({ status: "not_applied" });
    await expect(fake([[], [currentDiagnosticRow]]).completeFailed({ owner, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" })).resolves.toEqual({ status: "not_applied" });
  });

  it("fences stale owners after retry and terminal completion is immutable", async () => {
    const { id, owner: old } = await lease("fence");
    await expect(repo().claimRetry({ owner: old })).resolves.toMatchObject({ status: "retry_claimed", retryCount: 1 });
    const next = await repo().acquireLease({ identity: id, ownerToken: "next", leaseDurationMs: 10_000 });
    if (next.status !== "lease_acquired") throw new Error("Expected replacement owner");
    expect(next.owner.generation).toBeGreaterThan(old.generation);
    await expect(repo().beginCredentialInteraction({ owner: old })).resolves.toEqual({ status: "stale_owner" });
    await expect(repo().recordSubmitBarrier({ owner: old })).resolves.toEqual({ status: "stale_owner" });
    await expect(repo().completeAuthenticated({ owner: old })).resolves.toEqual({ status: "stale_owner" });
    await expect(repo().completeAuthenticated({ owner: next.owner })).resolves.toMatchObject({ status: "authenticated", record: { retryCount: 1 } });
    await expect(repo().completeFailed({ owner: next.owner, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" })).resolves.toEqual({ status: "terminal" });
  });

  it("serializes authentication/failure, bounded retries, and expiration reconciliation", async () => {
    const auth = await lease("race");
    const race = await Promise.all([repo().completeAuthenticated({ owner: auth.owner }), repo().completeFailed({ owner: auth.owner, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" })]);
    expect(race.filter((result) => result.status === "authenticated" || result.status === "failed")).toHaveLength(1);
    const retry = await lease("retry");
    expect((await Promise.all([repo().claimRetry({ owner: retry.owner }), repo().claimRetry({ owner: retry.owner })])).filter((result) => result.status === "retry_claimed")).toHaveLength(1);
    for (const token of ["two", "three"]) { const acquired = await repo().acquireLease({ identity: retry.id, ownerToken: token, leaseDurationMs: 10_000 }); if (acquired.status !== "lease_acquired") throw new Error("Expected retry lease"); await repo().claimRetry({ owner: acquired.owner }); }
    await expect(repo().findExact({ identity: retry.id })).resolves.toMatchObject({ status: "found", record: { status: "failed", retryCount: 2, generation: 6n, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" } });
    for (const phase of ["no", "credentials", "submit"] as const) {
      const current = await lease(`expired-${phase}`);
      if (phase !== "no") await repo().beginCredentialInteraction({ owner: current.owner });
      if (phase === "submit") await repo().recordSubmitBarrier({ owner: current.owner });
      await expire(current.id); const reconciled = await repo().reconcileExpiredLease({ identity: current.id });
      expect(reconciled).toMatchObject(phase === "no" ? { status: "lease_reconciled", record: { retryCount: 1, status: "active" } } : { status: "lease_reconciled", record: { status: "failed", failureClass: "interaction_outcome_uncertain" } });
      await expect(repo().completeAuthenticated({ owner: current.owner })).resolves.toMatchObject({ status: phase === "no" ? "stale_owner" : "terminal" });
    }
  });

  it.each(["no_credential_interaction", "credentials_may_have_reached_portal", "submit_may_have_been_dispatched"] as const)("resolves manual recovery with exact durable evidence for %s", async (phase) => {
    const { id, owner } = await lease(`observed-${phase}`); await episode(id);
    if (phase !== "no_credential_interaction") await repo().beginCredentialInteraction({ owner });
    if (phase === "submit_may_have_been_dispatched") await repo().recordSubmitBarrier({ owner });
    const result = await repo().resolveObservedRestoration(owner);
    if (result.status !== "resolved") throw new Error("Expected observed restoration");
    expect(result.evidence).toMatchObject({ identity: id, interactionPhase: phase, terminalGeneration: owner.generation + 1n });
    const durable = await repo().findExact({ identity: id });
    if (durable.status !== "found" || durable.record.status !== "authenticated") throw new Error("Expected authenticated terminal attempt");
    expect(result.evidence).toEqual({ identity: durable.record.identity, interactionPhase: durable.record.interactionPhase, terminalGeneration: durable.record.generation, authenticatedAt: durable.record.terminalAt });
    await expect(pool!.query('SELECT "consumerAttemptState", "consumerLeaseExpiresAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [id.bankCode])).resolves.toMatchObject({ rows: [{ consumerAttemptState: "resolved", consumerLeaseExpiresAt: null }] });
  });

  it.each([
    ["expired mutation lease", "mutation_started", "NOW() - INTERVAL '1 second'", "resolved"],
    ["active mutation lease", "mutation_started", "NOW() + INTERVAL '1 hour'", "active_mutation_owner"],
    ["legacy mutation", "mutation_started", "NULL", "active_mutation_owner"],
    ["reserved episode", "reserved", "NULL", "episode_not_resolvable"],
  ])("classifies %s", async (_name, state, expiry, status) => {
    const { id, owner } = await lease(`observed-${status}-${expiry === "NULL"}`); await episode(id, state, expiry);
    await expect(repo().resolveObservedRestoration(owner)).resolves.toMatchObject({ status });
  });

  it.each([
    ["wrong owner", async (_id: ReturnType<typeof attemptIdentity>, owner: Awaited<ReturnType<typeof lease>>["owner"]) => ({ ...owner, ownerToken: "wrong" }), "stale_owner"],
    ["stale generation", async (_id: ReturnType<typeof attemptIdentity>, owner: Awaited<ReturnType<typeof lease>>["owner"]) => ({ ...owner, generation: owner.generation + 1n }), "stale_owner"],
    ["expired auth lease", async (id: ReturnType<typeof attemptIdentity>, owner: Awaited<ReturnType<typeof lease>>["owner"]) => { await expire(id); return owner; }, "lease_expired"],
  ])("rejects %s", async (_name, change, status) => {
    const { id, owner } = await lease(`observed-${status}-${_name}`); await episode(id);
    await expect(repo().resolveObservedRestoration(await change(id, owner))).resolves.toMatchObject({ status });
  });

  it("fails closed for missing and mismatched durable identities", async () => {
    const { id, owner } = await lease("observed-identities"); await episode(id);
    await expect(repo().resolveObservedRestoration({ ...owner, identity: { ...id, attemptId: "other" } })).resolves.toEqual({ status: "identity_mismatch" });
    await pool!.query('UPDATE "BankSessionExpiryEpisode" SET "runId" = $2 WHERE "bankCode" = $1', [id.bankCode, "replacement"]);
    await expect(repo().resolveObservedRestoration(owner)).resolves.toEqual({ status: "identity_mismatch" });
    await expect(repo().resolveObservedRestoration({ ...owner, identity: { ...id, runId: "missing" } })).resolves.toEqual({ status: "missing", missing: "authentication_attempt" });
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [id.bankCode]);
    await expect(repo().resolveObservedRestoration(owner)).resolves.toEqual({ status: "missing", missing: "expiry_episode" });
  });

  it("classifies terminal attempts and supports only exact resolved idempotence", async () => {
    const failed = await lease("observed-failed"); await episode(failed.id); await repo().completeFailed({ owner: failed.owner, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" });
    await expect(repo().resolveObservedRestoration(failed.owner)).resolves.toEqual({ status: "terminal_conflict" });
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [failed.id.bankCode]);
    const resolved = await lease("observed-resolved"); await episode(resolved.id); const first = await repo().resolveObservedRestoration(resolved.owner);
    if (first.status !== "resolved") throw new Error("Expected observed restoration");
    await expect(repo().resolveObservedRestoration(resolved.owner)).resolves.toEqual({ status: "already_resolved", evidence: first.evidence });
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [resolved.id.bankCode]);
    await expect(repo().resolveObservedRestoration(resolved.owner)).resolves.toEqual({ status: "already_resolved", evidence: first.evidence });
    const conflict = await lease("observed-terminal-conflict"); await episode(conflict.id); await repo().completeAuthenticated({ owner: conflict.owner });
    await expect(repo().resolveObservedRestoration(conflict.owner)).resolves.toEqual({ status: "terminal_conflict" });
  });

  it("uses PostgreSQL time and preserves every maximal legal episode evidence set", async () => {
    const { id, owner } = await lease("observed-evidence"); await episode(id);
    await pool!.query('UPDATE "BankSessionExpiryEpisode" SET "publicationState" = \'published\', "publicationClaimToken" = \'publication\', "consumerAttemptSource" = \'scheduled\', "expiredAuditDeliveredAt" = NOW() - INTERVAL \'3 minutes\', "restoredAuditDeliveredAt" = NOW() - INTERVAL \'2 minutes\', "terminalFailureReason" = \'job_missing\', "terminalFailureReconciledAt" = NOW() - INTERVAL \'1 minute\', "updatedAt" = NOW() - INTERVAL \'4 minutes\' WHERE "bankCode" = $1', [id.bankCode]);
    const before = (await pool!.query('SELECT "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptSource", "consumerAttemptState", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt", "updatedAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [id.bankCode])).rows[0];
    const clock = await pool!.connect(); let authenticatedAt!: Date;
    try {
      const lower = (await clock.query<{ now: Date }>('SELECT NOW() AS "now"')).rows[0].now;
      const result = await repo().resolveObservedRestoration(owner);
      const upper = (await clock.query<{ now: Date }>('SELECT NOW() AS "now"')).rows[0].now;
      if (result.status !== "resolved") throw new Error("Expected observed restoration");
      authenticatedAt = result.evidence.authenticatedAt;
      expect(authenticatedAt.getTime()).toBeGreaterThanOrEqual(lower.getTime());
      expect(authenticatedAt.getTime()).toBeLessThanOrEqual(upper.getTime());
    } finally { clock.release(); }
    const resolved = (await pool!.query('SELECT "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptSource", "consumerAttemptState", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt", "updatedAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [id.bankCode])).rows[0];
    const { updatedAt: _beforeUpdatedAt, ...preserved } = before;
    void _beforeUpdatedAt;
    expect(resolved).toMatchObject({ ...preserved, consumerAttemptState: "resolved", consumerLeaseExpiresAt: null });
    expect(resolved.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    await expect(repo().findExact({ identity: id })).resolves.toMatchObject({ status: "found", record: { status: "authenticated", ownerToken: null, leaseExpiresAt: null, generation: owner.generation + 1n, terminalAt: authenticatedAt } });
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [id.bankCode]);
    const failure = await lease("observed-publication-failure"); await episode(failure.id);
    await pool!.query('UPDATE "BankSessionExpiryEpisode" SET "publicationState" = \'publishing\', "publicationClaimToken" = \'failed-publication\', "publicationFailureReportedAt" = NOW() - INTERVAL \'1 minute\', "expiredAuditDeliveredAt" = NOW() - INTERVAL \'3 minutes\', "restoredAuditDeliveredAt" = NOW() - INTERVAL \'2 minutes\', "updatedAt" = NOW() - INTERVAL \'4 minutes\' WHERE "bankCode" = $1', [failure.id.bankCode]);
    const failedPublication = (await pool!.query('SELECT "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptSource", "consumerAttemptState", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [failure.id.bankCode])).rows[0];
    await expect(repo().resolveObservedRestoration(failure.owner)).resolves.toMatchObject({ status: "resolved" });
    await expect(pool!.query('SELECT "expiredEventId", "runId", "expiredAuditDeliveredAt", "restoredAuditDeliveredAt", "publicationState", "publicationClaimToken", "publicationFailureReportedAt", "consumerClaimToken", "consumerAttemptSource", "consumerAttemptState", "consumerLeaseExpiresAt", "terminalFailureReason", "terminalFailureReconciledAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [failure.id.bankCode])).resolves.toMatchObject({ rows: [{ ...failedPublication, consumerAttemptState: "resolved", consumerLeaseExpiresAt: null }] });
    // PostgreSQL permits terminal evidence only for published episodes, but a publication failure only for publishing episodes.
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [failure.id.bankCode]);
    const rollback = await lease("observed-rollback"); await episode(rollback.id);
    await pool!.query('CREATE FUNCTION fail_observed_episode() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'forced\'; END $$; CREATE TRIGGER fail_observed_episode BEFORE UPDATE ON "BankSessionExpiryEpisode" FOR EACH ROW EXECUTE FUNCTION fail_observed_episode()');
    await expect(repo().resolveObservedRestoration(rollback.owner)).rejects.toThrow("forced");
    await pool!.query('DROP TRIGGER fail_observed_episode ON "BankSessionExpiryEpisode"; DROP FUNCTION fail_observed_episode()');
    await expect(repo().findExact({ identity: rollback.id })).resolves.toMatchObject({ status: "found", record: { status: "active", ownerToken: rollback.owner.ownerToken, generation: rollback.owner.generation } });
  });

  it("serializes concurrent resolvers and close into only coherent durable states", async () => {
    const concurrent = await lease("observed-concurrent"); await episode(concurrent.id);
    const results = await Promise.all([repo().resolveObservedRestoration(concurrent.owner), repo().resolveObservedRestoration(concurrent.owner)]);
    expect(results.map(({ status }) => status).sort()).toEqual(["already_resolved", "resolved"]);
    await pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [concurrent.id.bankCode]);
    const closing = await lease("observed-close"); await episode(closing.id);
    const [result, closed] = await Promise.all([repo().resolveObservedRestoration(closing.owner), pool!.query('DELETE FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1 AND "runId" = $2 AND "expiredEventId" = $3 AND ("consumerAttemptState" IS NULL OR "consumerAttemptState" = \'resolved\')', [closing.id.bankCode, closing.id.runId, `expired-${closing.id.runId}`])]);
    expect(result).toMatchObject({ status: "resolved" });
    const attempt = (await pool!.query('SELECT "status", "ownerToken", "leaseExpiresAt", "generation" FROM "BankSessionAuthenticationAttempt" WHERE "bankCode" = $1 AND "runId" = $2', [closing.id.bankCode, closing.id.runId])).rows[0];
    const finalEpisode = (await pool!.query('SELECT "consumerAttemptState", "consumerLeaseExpiresAt" FROM "BankSessionExpiryEpisode" WHERE "bankCode" = $1', [closing.id.bankCode])).rows[0];
    expect(attempt).toMatchObject({ status: "authenticated", ownerToken: null, leaseExpiresAt: null, generation: String(closing.owner.generation + 1n) });
    if (closed.rowCount === 1) expect(finalEpisode).toBeUndefined();
    else expect(finalEpisode).toEqual({ consumerAttemptState: "resolved", consumerLeaseExpiresAt: null });
  });

  it.each([
    ["invalid enum", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"status\", \"interactionPhase\", \"updatedAt\") VALUES ('auth-contract-invalid-enum', 'run', 'attempt', 'bad', 'no_credential_interaction', NOW())"],
    ["blank identity", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"updatedAt\") VALUES (' ', 'run', 'attempt', NOW())"],
    ["invalid retry", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"retryCount\", \"updatedAt\") VALUES ('auth-contract-invalid-retry', 'run', 'attempt', 3, NOW())"],
    ["invalid generation", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"generation\", \"updatedAt\") VALUES ('auth-contract-invalid-generation', 'run', 'attempt', -1, NOW())"],
    ["invalid ownership tuple", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"ownerToken\", \"updatedAt\") VALUES ('auth-contract-invalid-owner', 'run', 'attempt', 'owner', NOW())"],
    ["mismatched safe failure pair", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"status\", \"failureClass\", \"operatorReason\", \"terminalAt\", \"updatedAt\") VALUES ('auth-contract-invalid-failure-pair', 'run', 'attempt', 'failed', 'transient_pre_interaction', 'authentication_attempt_requires_review', NOW(), NOW())"],
    ["authenticated failure fields", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"status\", \"failureClass\", \"terminalAt\", \"updatedAt\") VALUES ('auth-contract-authenticated-failure', 'run', 'attempt', 'authenticated', 'unclassified_failure', NOW(), NOW())"],
    ["active terminal timestamp", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"terminalAt\", \"updatedAt\") VALUES ('auth-contract-active-terminal', 'run', 'attempt', NOW(), NOW())"],
    ["terminal owner and lease", "INSERT INTO \"BankSessionAuthenticationAttempt\" (\"bankCode\", \"runId\", \"attemptId\", \"status\", \"ownerToken\", \"leaseExpiresAt\", \"terminalAt\", \"updatedAt\") VALUES ('auth-contract-terminal-owner', 'run', 'attempt', 'authenticated', 'owner', NOW(), NOW(), NOW())"],
  ])("migration rejects %s", async (_name, sql) => { await expect(pool!.query(sql)).rejects.toMatchObject({ code: "23514" }); });
});
