import { describe, expect, it, vi } from "vitest";

import type { AuditEvent, AuditSink } from "../audit";
import {
  createManualRecoveryResolutionAuditEvent,
  deliverManualRecoveryResolutionAudit,
  type ManualRecoveryResolutionAuditOutbox,
  type ManualRecoveryResolutionAuditOutboxRepository,
} from "./manual-recovery-resolution-audit-delivery";

const outbox: ManualRecoveryResolutionAuditOutbox = {
  id: "outbox-1", state: "pending", leaseOwner: null, leaseExpiresAt: null, deliveredAt: null,
  resolution: { id: "resolution-1", bankCode: "popular", expiredEventId: "event-1", runId: "run-1", outcome: "resolved_no_retry", reason: "closed_without_retry", operatorId: "admin-1", resolvedAt: new Date("2026-07-28T19:00:00.000Z") },
};

function repository(overrides: Partial<ManualRecoveryResolutionAuditOutboxRepository> = {}): ManualRecoveryResolutionAuditOutboxRepository {
  return { findClaimable: vi.fn(async () => outbox), claim: vi.fn(async () => true), markDelivered: vi.fn(async () => true), releaseClaim: vi.fn(async () => true), inspect: vi.fn(async () => outbox), ...overrides };
}

const record = vi.fn(async (event: AuditEvent) => { void event; });
const audit: AuditSink = { record, list: async () => [] };

describe("manual recovery resolution audit delivery", () => {
  it("projects only the deterministic, allowlisted audit event", () => {
    expect(createManualRecoveryResolutionAuditEvent(outbox.resolution)).toEqual({ id: "bank-autologin-manual-recovery-resolved:resolution-1", actorId: "admin-1", actorRole: "admin", action: "bank_autologin.manual_recovery_resolved", target: "manual_recovery_resolution", targetId: "resolution-1", metadata: { bankCode: "popular", expiredEventId: "event-1", runId: "run-1", outcome: "resolved_no_retry", operatorId: "admin-1", reason: "closed_without_retry", resolvedAt: "2026-07-28T19:00:00.000Z" }, createdAt: outbox.resolution.resolvedAt });
  });

  it("is idle when no row is claimable and loses a competing claim without recording", async () => {
    await expect(deliverManualRecoveryResolutionAudit(repository({ findClaimable: async () => null }), audit, "replica-a", 1000)).resolves.toBe(false);
    await expect(deliverManualRecoveryResolutionAudit(repository({ claim: async () => false }), audit, "replica-a", 1000)).resolves.toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("records then acknowledges an exact-owner claim", async () => {
    const repo = repository();
    await expect(deliverManualRecoveryResolutionAudit(repo, audit, "replica-a", 1000)).resolves.toBe(true);
    expect(repo.markDelivered).toHaveBeenCalledWith("outbox-1", "replica-a");
  });

  it("releases its claim when the sink fails", async () => {
    const repo = repository(); const failure = new Error("sink failed");
    await expect(deliverManualRecoveryResolutionAudit(repo, { ...audit, record: async () => { throw failure; } }, "replica-a", 1000)).rejects.toBe(failure);
    expect(repo.releaseClaim).toHaveBeenCalledWith("outbox-1", "replica-a");
  });

  it("preserves sink and release failures", async () => {
    const sinkFailure = new Error("sink"); const releaseFailure = new Error("release");
    await expect(deliverManualRecoveryResolutionAudit(repository({ releaseClaim: async () => { throw releaseFailure; } }), { ...audit, record: async () => { throw sinkFailure; } }, "replica-a", 1000)).rejects.toMatchObject({ errors: [sinkFailure, releaseFailure] });
  });

  it("does not acknowledge stale ownership or repeat a delivered row", async () => {
    const stale = repository({ markDelivered: async () => false });
    await expect(deliverManualRecoveryResolutionAudit(stale, audit, "old-owner", 1000)).rejects.toThrow("acknowledgement lost");
    await expect(deliverManualRecoveryResolutionAudit(repository({ findClaimable: async () => null }), audit, "replica-b", 1000)).resolves.toBe(false);
  });

  it("allows expiry recovery to replay the deterministic event after acknowledgement loss", async () => {
    const repo = repository({ markDelivered: vi.fn(async () => false) });
    await expect(deliverManualRecoveryResolutionAudit(repo, audit, "replica-a", 1)).rejects.toThrow("acknowledgement lost");
    await expect(deliverManualRecoveryResolutionAudit(repository(), audit, "replica-b", 1)).resolves.toBe(true);
    expect(record.mock.calls.at(-1)![0].id).toBe(record.mock.calls.at(-2)![0].id);
  });
});
