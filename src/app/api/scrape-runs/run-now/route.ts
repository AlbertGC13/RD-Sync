import { resolvePrincipal } from "../../../../modules/auth";
import { defaultAuditSink } from "../../audit/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository } from "../defaults";
import { defaultIngestionConsumer } from "../consumer-defaults";
import {
  ActiveRunExistsError,
  scheduleIngestionRunNow,
  UnsupportedRunNowBankError,
  type RunNowDependencies,
  type RunNowRequest,
} from "../run-now";
import type { InMemoryIngestionConsumer } from "../../../../worker/ingestion-consumer";

export interface RunNowHandlerDependencies extends RunNowDependencies {
  consumer?: InMemoryIngestionConsumer;
}

const defaultDependencies: RunNowHandlerDependencies = {
  // Delegate to the shared repository instance explicitly. We cannot spread
  // the repo (class methods live on the prototype, not as own properties),
  // so we bind each method and add the active-run lock on top.
  scrapeRuns: {
    createQueued: (input) => defaultScrapeRunRepository.createQueued(input),
    markFailed: (runId, safeErrorSummary, endedAt) =>
      defaultScrapeRunRepository.markFailed(runId, safeErrorSummary, endedAt),
    // Active-run lock: reject a new manual "Run now" when the target bank
    // already has a queued or running run. Uses the shared repository's list
    // so both the in-memory and Prisma back ends enforce the same rule.
    hasActiveRunForBank: async (bankId: string) => {
      const active = await defaultScrapeRunRepository.list({ bankId });
      return active.some(
        (run) => run.status === "queued" || run.status === "running",
      );
    },
  },
  queue: defaultIngestionQueue,
  auditSink: defaultAuditSink,
  consumer: defaultIngestionConsumer,
};

// ---------------------------------------------------------------------------
// Error categorisation
//
// Three buckets must be handled independently — collapsing them all into
// 401/403 (the previous behaviour) hides real infrastructure problems from
// operators and burns queue/db capacity on doomed retries.
// ---------------------------------------------------------------------------

const SAFE_AUTH_MESSAGE = "Unable to schedule run";
const SAFE_VALIDATION_MESSAGE = "Bank not currently supported for manual runs";
const SAFE_INFRA_MESSAGE = "Unable to schedule run";
const SAFE_CONFLICT_MESSAGE = "An active scrape run already exists for this bank";

function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Thrown by requireRole (run-now path) when no principal is resolved, or
  // when a role check fails. The run-now path now allows every authenticated
  // role, so in practice only "Authentication required" (null principal) can
  // surface here. The "Admin role required" branch is retained as
  // defense-in-depth for any future caller that reintroduces
  // assertCanAccessBankSession on this path.
  if (error.message === "Admin role required") return true;
  if (error.message === "Authentication required") return true;
  if (/^Role .* is not allowed$/.test(error.message)) return true;
  return false;
}

function isValidationError(error: unknown): boolean {
  return error instanceof UnsupportedRunNowBankError;
}

function isConflictError(error: unknown): boolean {
  return error instanceof ActiveRunExistsError;
}

export function createPostScrapeRunNowHandler(dependencies: RunNowHandlerDependencies) {
  return async function postScrapeRunNow(request: Request): Promise<Response> {
    // Backend authz is the ONLY path to admin: a signed session cookie or
    // RD_SYNC_TRUST_PROXY_HEADERS-enabled headers. There is no query-param
    // bypass.
    const principal = resolvePrincipal(request);
    const payload = await readOptionalJson(request);

    try {
      const run = await scheduleIngestionRunNow(
        {
          principal,
          bankId: optionalString(payload.bankId),
          accountFingerprint: optionalString(payload.accountFingerprint),
        },
        dependencies,
      );

      // Kick the in-process consumer fire-and-forget so the 202 is not delayed.
      // Errors are intentionally swallowed here — the run record in the repository
      // captures the final status, and the consumer's onJobError recovery marks
      // any dequeued-but-failed run `failed` so it is never orphaned in
      // `queued`. BullMQ + a separate worker replaces this in PR5+.
      if (dependencies.consumer) {
        void dependencies.consumer.drainPending().catch(() => undefined);
      }

      return Response.json({ run }, { status: 202 });
    } catch (error) {
      if (isAuthenticationError(error)) {
        // 401 when no principal was resolved, 403 when one was but lacked role.
        return Response.json({ error: SAFE_AUTH_MESSAGE }, { status: principal ? 403 : 401 });
      }

      if (isValidationError(error)) {
        // Unsupported bank — auditable, client-fixable, NOT an infra failure.
        // 400 Bad Request so clients can distinguish "you sent garbage" from
        // "we tried and the world broke".
        return Response.json({ error: SAFE_VALIDATION_MESSAGE }, { status: 400 });
      }

      if (isConflictError(error)) {
        // Active run already exists for this bank — NOT an error, a guard.
        // 409 Conflict so the UI can surface a clear "wait for the current
        // run" affordance and avoid scheduling duplicate ingestion.
        return Response.json({ error: SAFE_CONFLICT_MESSAGE }, { status: 409 });
      }

      // Real infrastructure failure: DB / Redis / BullMQ / queue overload.
      // Log full diagnostic context server-side; return a generic 5xx so
      // operators see a clear failure mode but the response never leaks
      // raw error.message or stack frames to the browser.
      console.error("[run-now] failed to schedule ingestion", {
        actorId: principal?.id ?? null,
        actorRole: principal?.role ?? null,
        bankId: optionalString(payload.bankId) ?? null,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
      });
      return Response.json({ error: SAFE_INFRA_MESSAGE }, { status: 503 });
    }
  };
}

export const POST = createPostScrapeRunNowHandler(defaultDependencies);

export { SAFE_CONFLICT_MESSAGE };

async function readOptionalJson(request: Request): Promise<Partial<RunNowRequest>> {
  const text = await request.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
