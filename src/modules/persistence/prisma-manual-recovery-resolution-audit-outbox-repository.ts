import type { PrismaClient } from "../../generated/prisma/client";
import type { ManualRecoveryResolutionAuditOutbox, ManualRecoveryResolutionAuditOutboxRepository } from "../bank-sessions/manual-recovery-resolution-audit-delivery";

type Row = { id: string; state: string; leaseOwner: string | null; leaseExpiresAt: Date | null; deliveredAt: Date | null; resolutionId: string; bankCode: string; expiredEventId: string; runId: string; outcome: string; reason: string; operatorId: string; resolvedAt: Date };

function map(row: Row): ManualRecoveryResolutionAuditOutbox {
  if (row.state !== "pending" && row.state !== "delivering" && row.state !== "delivered") throw new Error("Invalid manual recovery audit outbox state");
  return { id: row.id, state: row.state, leaseOwner: row.leaseOwner, leaseExpiresAt: row.leaseExpiresAt, deliveredAt: row.deliveredAt, resolution: { id: row.resolutionId, bankCode: row.bankCode, expiredEventId: row.expiredEventId, runId: row.runId, outcome: row.outcome as ManualRecoveryResolutionAuditOutbox["resolution"]["outcome"], reason: row.reason as ManualRecoveryResolutionAuditOutbox["resolution"]["reason"], operatorId: row.operatorId, resolvedAt: row.resolvedAt } };
}

export class PrismaManualRecoveryResolutionAuditOutboxRepository implements ManualRecoveryResolutionAuditOutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findClaimable(): Promise<ManualRecoveryResolutionAuditOutbox | null> {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT o."id", o."state", o."leaseOwner", o."leaseExpiresAt", o."deliveredAt", r."id" AS "resolutionId", r."bankCode", r."expiredEventId", r."runId", r."outcome", r."reason", r."operatorId", r."resolvedAt" FROM "ManualRecoveryResolutionAuditOutbox" o JOIN "ManualRecoveryResolution" r ON r."id" = o."resolutionId" WHERE o."state" = 'pending' OR (o."state" = 'delivering' AND o."leaseExpiresAt" < NOW()) ORDER BY o."createdAt", o."id" LIMIT 1`;
    return rows[0] ? map(rows[0]) : null;
  }

  async claim(id: string, leaseOwner: string, leaseMs: number): Promise<boolean> {
    assertLease(leaseOwner, leaseMs);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = 'delivering', "leaseOwner" = ${leaseOwner}, "leaseExpiresAt" = NOW() + (${leaseMs} * INTERVAL '1 millisecond') WHERE "id" = ${id} AND ("state" = 'pending' OR ("state" = 'delivering' AND "leaseExpiresAt" < NOW())) RETURNING "id"`;
    return rows.length === 1;
  }

  async markDelivered(id: string, leaseOwner: string): Promise<boolean> {
    assertOwner(leaseOwner);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = 'delivered', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "deliveredAt" = NOW() WHERE "id" = ${id} AND "state" = 'delivering' AND "leaseOwner" = ${leaseOwner} RETURNING "id"`;
    return rows.length === 1;
  }

  async releaseClaim(id: string, leaseOwner: string): Promise<boolean> {
    assertOwner(leaseOwner);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`UPDATE "ManualRecoveryResolutionAuditOutbox" SET "state" = 'pending', "leaseOwner" = NULL, "leaseExpiresAt" = NULL WHERE "id" = ${id} AND "state" = 'delivering' AND "leaseOwner" = ${leaseOwner} RETURNING "id"`;
    return rows.length === 1;
  }

  async inspect(id: string): Promise<ManualRecoveryResolutionAuditOutbox | null> {
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT o."id", o."state", o."leaseOwner", o."leaseExpiresAt", o."deliveredAt", r."id" AS "resolutionId", r."bankCode", r."expiredEventId", r."runId", r."outcome", r."reason", r."operatorId", r."resolvedAt" FROM "ManualRecoveryResolutionAuditOutbox" o JOIN "ManualRecoveryResolution" r ON r."id" = o."resolutionId" WHERE o."id" = ${id}`;
    return rows[0] ? map(rows[0]) : null;
  }
}

function assertOwner(owner: string): void { if (!owner.trim()) throw new Error("Audit delivery lease owner must be nonblank"); }
function assertLease(owner: string, leaseMs: number): void { assertOwner(owner); if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Audit delivery lease duration must be positive"); }
