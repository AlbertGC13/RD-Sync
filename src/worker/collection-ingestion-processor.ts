import { createAuditEvent, type AuditSink } from "../modules/audit";
import { normalizeBankMovement, type BankMovement } from "../modules/transactions";
import type { AdminAlertSink, IngestionResult, ResolveScraper, ScrapeRunRepository, TransactionUpsertRepository } from "./queues";

type JobData = Readonly<{ runId: string; bankId: string; accountFingerprint: string }>;
type TerminalStatus = "failed" | "needs_admin_action";

export type CollectionIngestionProcessorDependencies = Readonly<{
  scrapeRuns: ScrapeRunRepository;
  transactions: TransactionUpsertRepository;
  resolveScraper: ResolveScraper;
  adminAlerts?: AdminAlertSink;
  auditSink?: Pick<AuditSink, "record">;
  now?: () => Date;
}>;

const systemActor = "system:ingestion-worker";
const failureSummary = "Ingestion collection failed";
const sessionSummary = "Bank session requires admin action";

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (![...required, ...optional].includes(key))) || !required.every((key) => keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    record[key as string] = descriptor.value;
  }
  return record;
}

function parseData(value: unknown): JobData | null {
  const data = exact(value, ["runId", "bankId", "accountFingerprint"]);
  return data && [data.runId, data.bankId, data.accountFingerprint].every((part) => typeof part === "string" && /\S/.test(part))
    ? { runId: data.runId as string, bankId: data.bankId as string, accountFingerprint: data.accountFingerprint as string }
    : null;
}

function safeRunId(value: unknown): string | null {
  try {
    if (value === null || typeof value !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "runId");
    return descriptor?.enumerable && "value" in descriptor && typeof descriptor.value === "string" && /\S/.test(descriptor.value) ? descriptor.value : null;
  } catch { return null; }
}

function collection(value: unknown): readonly BankMovement[] | TerminalStatus | null {
  const result = exact(value, ["status", "movements"], ["safeErrorSummary", "cause"]);
  if (!result || !Array.isArray(result.movements)) return null;
  if (result.status === "collected") return result.movements as BankMovement[];
  return result.status === "needs_admin_action" ? "needs_admin_action" : null;
}

export function createCollectionIngestionProcessor(dependencies: CollectionIngestionProcessorDependencies): (job: unknown) => Promise<IngestionResult> {
  const now = dependencies.now ?? (() => new Date());
  const audit = async (action: string, data: JobData, metadata?: Record<string, unknown>) => {
    try { await dependencies.auditSink?.record(createAuditEvent({ actorId: systemActor, actorRole: null, action, target: "scrape_run", targetId: data.runId, metadata: { bankId: data.bankId, ...metadata } })); } catch { /* audit is non-blocking */ }
  };
  const terminal = async (status: TerminalStatus, data: JobData, summary: string): Promise<IngestionResult> => {
    try {
      if (status === "needs_admin_action") await dependencies.scrapeRuns.markNeedsAdminAction(data.runId, summary, now());
      else await dependencies.scrapeRuns.markFailed(data.runId, summary, now());
    } catch { return { status: "failed", inserted: 0, skipped: 0 }; }
    try { await dependencies.adminAlerts?.notifyIngestionAttention({ runId: data.runId, bankId: data.bankId, status, safeErrorSummary: summary }); } catch { /* alerts are non-blocking */ }
    await audit(`scrape_run.${status}`, data, { safeErrorSummary: summary });
    return { status, inserted: 0, skipped: 0 };
  };

  return async (job): Promise<IngestionResult> => {
    let rawData: unknown;
    try { rawData = exact(job, ["data"])?.data; } catch { rawData = undefined; }
    const data = (() => { try { return parseData(rawData); } catch { return null; } })();
    if (!data) {
      const runId = safeRunId(rawData);
      if (!runId) return { status: "failed", inserted: 0, skipped: 0 };
      return terminal("failed", { runId, bankId: "unknown", accountFingerprint: "unknown" }, failureSummary);
    }
    try { await dependencies.scrapeRuns.markRunning(data.runId, now()); } catch { return { status: "failed", inserted: 0, skipped: 0 }; }
    await audit("scrape_run.started", data);
    let outcome: readonly BankMovement[] | TerminalStatus | null;
    try {
      outcome = collection(await dependencies.resolveScraper(data.bankId).collect());
      if (outcome === null) return terminal("failed", data, failureSummary);
      if (!Array.isArray(outcome)) return terminal("needs_admin_action", data, sessionSummary);
      const counts = outcome.length === 0 ? { inserted: 0, skipped: 0 } : await dependencies.transactions.upsertMany(outcome.map((movement) => normalizeBankMovement(movement, { scrapeRunId: data.runId })));
      try { await dependencies.scrapeRuns.markSucceeded(data.runId, { insertedCount: counts.inserted, skippedCount: counts.skipped }, now()); } catch { return { status: "failed", inserted: 0, skipped: 0 }; }
      await audit("scrape_run.succeeded", data, { inserted: counts.inserted, skipped: counts.skipped });
      return { status: "succeeded", inserted: counts.inserted, skipped: counts.skipped };
    } catch { return terminal("failed", data, failureSummary); }
  };
}
