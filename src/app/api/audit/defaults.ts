import { InMemoryAuditSink } from "../../../modules/audit";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncAuditSink?: InMemoryAuditSink;
};

export const defaultAuditSink =
  (globalRegistry.__rdSyncAuditSink ??= new InMemoryAuditSink());
