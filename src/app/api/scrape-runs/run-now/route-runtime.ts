import { resolvePrincipal } from "../../../../modules/auth";
import type { InMemoryIngestionConsumer } from "../../../../worker/ingestion-consumer";
import { defaultAuditSink } from "../../audit/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository } from "../defaults";
import { ActiveRunExistsError, scheduleIngestionRunNow, UnsupportedRunNowBankError, type RunNowDependencies, type RunNowRequest } from "../run-now";

export interface RunNowHandlerDependencies extends RunNowDependencies {
  consumer?: InMemoryIngestionConsumer;
}

const SAFE_AUTH_MESSAGE = "Unable to schedule run"; const SAFE_VALIDATION_MESSAGE = "Bank not currently supported for manual runs"; const SAFE_INFRA_MESSAGE = "Unable to schedule run";
export const SAFE_CONFLICT_MESSAGE = "An active scrape run already exists for this bank";

function defaultDependencies(consumer: InMemoryIngestionConsumer | undefined): RunNowHandlerDependencies {
  return {
    scrapeRuns: {
      createQueued: (input) => defaultScrapeRunRepository.createQueued(input),
      markFailed: (runId, safeErrorSummary, endedAt) => defaultScrapeRunRepository.markFailed(runId, safeErrorSummary, endedAt),
      hasActiveRunForBank: async (bankId) => (await defaultScrapeRunRepository.list({ bankId }))
        .some((run) => run.status === "queued" || run.status === "running"),
    },
    queue: defaultIngestionQueue,
    auditSink: defaultAuditSink,
    consumer,
  };
}

const isAuthenticationError = (error: unknown) => error instanceof Error && (error.message === "Admin role required" || error.message === "Authentication required" || /^Role .* is not allowed$/.test(error.message));

export function createPostScrapeRunNowHandler(dependencies: RunNowHandlerDependencies) {
  return async function postScrapeRunNow(request: Request): Promise<Response> {
    const principal = resolvePrincipal(request);
    const payload = await readOptionalJson(request);
    try {
      const run = await scheduleIngestionRunNow({ principal, bankId: optionalString(payload.bankId), accountFingerprint: optionalString(payload.accountFingerprint) }, dependencies);
      if (dependencies.consumer) void dependencies.consumer.drainPending().catch(() => undefined);
      return Response.json({ run }, { status: 202 });
    } catch (error) {
      if (isAuthenticationError(error)) return Response.json({ error: SAFE_AUTH_MESSAGE }, { status: principal ? 403 : 401 });
      if (error instanceof UnsupportedRunNowBankError) return Response.json({ error: SAFE_VALIDATION_MESSAGE }, { status: 400 });
      if (error instanceof ActiveRunExistsError) return Response.json({ error: SAFE_CONFLICT_MESSAGE }, { status: 409 });
      console.error("[run-now] failed to schedule ingestion", { actorId: principal?.id ?? null, actorRole: principal?.role ?? null, bankId: optionalString(payload.bankId) ?? null, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error });
      return Response.json({ error: SAFE_INFRA_MESSAGE }, { status: 503 });
    }
  };
}

const handlers = new Map<InMemoryIngestionConsumer | undefined, (request: Request) => Promise<Response>>();

export function postDefaultScrapeRunNow(request: Request, consumer: InMemoryIngestionConsumer | undefined): Promise<Response> {
  let handler = handlers.get(consumer); if (!handler) { handler = createPostScrapeRunNowHandler(defaultDependencies(consumer)); handlers.set(consumer, handler); }
  return handler(request);
}

async function readOptionalJson(request: Request): Promise<Partial<RunNowRequest>> {
  const text = await request.text(); if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const optionalString = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
