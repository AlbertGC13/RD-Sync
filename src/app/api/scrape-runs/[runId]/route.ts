import { requireRole, resolvePrincipal } from "../../../../modules/auth";
import type { ScrapeRunRecord } from "../../../../modules/scrape-runs";
import type { ScrapeRunStatus } from "../../../../worker/queues";
import { defaultScrapeRunRepository } from "../defaults";

// ---------------------------------------------------------------------------
// Safe response shape
//
// Only the fields the client needs to drive polling are exposed. Internal
// timestamps (createdAt/updatedAt), the redacted-but-internal safeErrorSummary,
// account fingerprints, and any queue/diagnostic details are deliberately
// omitted so the browser is never tempted to surface them. The client already
// holds the runId (from the 202 body), so including `id` here is harmless and
// keeps the response self-describing for tests — RefreshButton never displays it.
// ---------------------------------------------------------------------------

export interface ScrapeRunStatusRun {
  id: string;
  bankId: string;
  status: ScrapeRunStatus;
  insertedCount: number;
  skippedCount: number;
}

export interface ScrapeRunStatusResponse {
  run: ScrapeRunStatusRun;
}

const SAFE_NOT_FOUND_MESSAGE = "Scrape run not found";
const SAFE_INFRA_MESSAGE = "Unable to read scrape run status";

interface ScrapeRunStatusRouteContext {
  // Next.js 15 makes params a Promise; older callers may pass a plain object.
  // Mirrors the convention used by /api/transactions/[id]/review.
  params: Promise<{ runId: string }> | { runId: string };
}

export interface GetScrapeRunStatusDependencies {
  scrapeRuns: {
    findById(runId: string): Promise<ScrapeRunRecord | null>;
  };
}

const defaultDependencies: GetScrapeRunStatusDependencies = {
  scrapeRuns: defaultScrapeRunRepository,
};

/**
 * Build a GET handler for a single scrape-run status. Injecting the
 * repository lets tests drive the auth/not-found/infra paths with an
 * in-memory repository and no database.
 */
export function createGetScrapeRunStatusHandler(dependencies: GetScrapeRunStatusDependencies) {
  return async function getScrapeRunStatus(
    request: Request,
    context: ScrapeRunStatusRouteContext,
  ): Promise<Response> {
    // Authz lives on the backend — every authenticated role may read a single
    // run status so any operator can poll their own manual refresh. UI role
    // checks are affordances only.
    const principal = resolvePrincipal(request);

    try {
      requireRole(principal, ["admin", "reviewer", "viewer"]);
    } catch (error) {
      return jsonError(error, principal ? 403 : 401);
    }

    const { runId } = await Promise.resolve(context.params);

    let record: ScrapeRunRecord | null;
    try {
      record = await dependencies.scrapeRuns.findById(runId);
    } catch (error) {
      // Real infrastructure failure (DB down, Prisma timeout). Log full
      // diagnostic context server-side; return a generic 5xx so the raw
      // error.message / stack never reaches the browser.
      console.error("[scrape-runs/:runId] failed to read scrape run status", {
        runId,
        actorId: principal?.id ?? null,
        actorRole: principal?.role ?? null,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
      });
      return Response.json({ error: SAFE_INFRA_MESSAGE }, { status: 503 });
    }

    if (!record) {
      return Response.json({ error: SAFE_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // `satisfies ScrapeRunStatusResponse` locks the response shape at
    // compile time so a future projection drift (e.g. adding/removing a
    // field in toSafeScrapeRunStatus) is caught here, not by the client.
    return Response.json(
      { run: toSafeScrapeRunStatus(record) } satisfies ScrapeRunStatusResponse,
      { status: 200 },
    );
  };
}

export const GET = createGetScrapeRunStatusHandler(defaultDependencies);

/**
 * Project a repository record onto the safe client-facing shape. Exported so
 * tests can assert the projection strips unsafe fields without constructing a
 * full HTTP round-trip.
 */
export function toSafeScrapeRunStatus(record: ScrapeRunRecord): ScrapeRunStatusRun {
  return {
    id: record.id,
    bankId: record.bankId,
    status: record.status,
    insertedCount: record.insertedCount,
    skippedCount: record.skippedCount,
  };
}

function jsonError(error: unknown, fallbackStatus: number): Response {
  // requireRole throws "Authentication required" / "Role <r> is not allowed" —
  // both are safe, generic, and carry no internal diagnostics. Matches the
  // convention established by /api/transactions/[id]/review.
  const message = error instanceof Error ? error.message : "Request failed";
  return Response.json({ error: message }, { status: fallbackStatus });
}
