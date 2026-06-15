/**
 * Default audit sink singleton.
 *
 * Env-switch: When DATABASE_URL is set (read at module-load time, consistent
 * with the existing pattern), the Prisma-backed audit sink is used instead of
 * the in-memory one. Both implementations satisfy the AuditSink interface so
 * no consumer code changes are required.
 *
 * The instance is anchored on globalThis so that Next.js dev module-graph
 * hot-reloads and multiple module graphs within the same process share a
 * single instance.
 */

import { InMemoryAuditSink } from "../../../modules/audit/index";
import { PrismaAuditSink } from "../../../modules/persistence/prisma-audit-sink";

type AnyAuditSink = InMemoryAuditSink | PrismaAuditSink;

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncAuditSink?: AnyAuditSink;
};

function createAuditSink(): AnyAuditSink {
  if (process.env.DATABASE_URL) {
    return new PrismaAuditSink();
  }
  return new InMemoryAuditSink();
}

export const defaultAuditSink: AnyAuditSink =
  (globalRegistry.__rdSyncAuditSink ??= createAuditSink());
