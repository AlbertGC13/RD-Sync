/**
 * Prisma-backed AuditSink implementation.
 * Satisfies the same AuditSink interface as InMemoryAuditSink.
 *
 * Metadata is already redacted upstream by createAuditEvent — this sink
 * does not re-redact.
 */

import type { Prisma } from "../../generated/prisma/client";
import type { AuditSink, AuditEvent } from "../audit/index";
import { getPrismaClient } from "./prisma-client";

export class PrismaAuditSink implements AuditSink {
  private get prisma() {
    return getPrismaClient();
  }

  async record(event: AuditEvent): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        id: event.id,
        actorId: event.actorId ?? null,
        actorRole: event.actorRole ?? null,
        action: event.action,
        target: event.target,
        targetId: event.targetId ?? null,
        metadata: (event.metadata as Prisma.InputJsonValue | null) ?? undefined,
        createdAt: event.createdAt,
      },
    });
  }

  /**
   * List all audit events ordered by createdAt ascending.
   * Provided for parity with InMemoryAuditSink.list() and for contract tests.
   */
  async list(): Promise<AuditEvent[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: { createdAt: "asc" },
    });

    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action,
      target: row.target,
      targetId: row.targetId,
      metadata: row.metadata as Record<string, unknown> | null,
      createdAt: row.createdAt,
    }));
  }
}
