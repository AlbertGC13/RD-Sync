/**
 * Prisma-backed AuditSink implementation.
 * Satisfies the same AuditSink interface as InMemoryAuditSink.
 *
 * Metadata is already redacted upstream by createAuditEvent — this sink
 * does not re-redact.
 */

import type { Prisma } from "../../generated/prisma/client";
import type { AuditSink, AuditEvent, AuditListOptions } from "../audit/index";
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
   * List audit events ordered newest-first (createdAt DESC, id DESC for
   * stable tie-breaking). Supports optional offset/limit pagination.
   */
  async list(options?: AuditListOptions): Promise<AuditEvent[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(options?.offset !== undefined ? { skip: options.offset } : {}),
      ...(options?.limit !== undefined ? { take: options.limit } : {}),
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
