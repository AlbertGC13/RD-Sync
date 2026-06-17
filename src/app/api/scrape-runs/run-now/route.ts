import { resolvePrincipal } from "../../../../modules/auth";
import { defaultAuditSink } from "../../audit/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository } from "../defaults";
import { defaultIngestionConsumer } from "../consumer-defaults";
import {
  scheduleAdminIngestionRunNow,
  type RunNowDependencies,
  type RunNowRequest,
} from "../run-now";
import type { InMemoryIngestionConsumer } from "../../../../worker/ingestion-consumer";

export interface RunNowHandlerDependencies extends RunNowDependencies {
  consumer?: InMemoryIngestionConsumer;
}

const defaultDependencies: RunNowHandlerDependencies = {
  scrapeRuns: defaultScrapeRunRepository,
  queue: defaultIngestionQueue,
  auditSink: defaultAuditSink,
  consumer: defaultIngestionConsumer,
};

export function createPostScrapeRunNowHandler(dependencies: RunNowHandlerDependencies) {
  return async function postScrapeRunNow(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const principal =
      resolveApiPreviewPrincipal(url.searchParams) ?? resolvePrincipal(request);
    const payload = await readOptionalJson(request);

    try {
      const run = await scheduleAdminIngestionRunNow(
        {
          principal,
          bankId: optionalString(payload.bankId),
          accountFingerprint: optionalString(payload.accountFingerprint),
        },
        dependencies,
      );

      // Kick the in-process consumer fire-and-forget so the 202 is not delayed.
      // Errors are intentionally swallowed here — the run record in the repository
      // captures the final status.  BullMQ + a separate worker replaces this in PR5+.
      if (dependencies.consumer) {
        void dependencies.consumer.drainPending().catch(() => undefined);
      }

      return Response.json({ run }, { status: 202 });
    } catch (error) {
      return jsonError(error, principal ? 403 : 401);
    }
  };
}

export const POST = createPostScrapeRunNowHandler(defaultDependencies);

export function resolveApiPreviewPrincipal(searchParams: URLSearchParams): RunNowRequest["principal"] {
  if (process.env.NODE_ENV === "production" || process.env.RD_SYNC_DEV_PREVIEW !== "enabled") {
    return null;
  }

  return searchParams.get("previewRole") === "admin"
    ? { id: "admin-preview", role: "admin" }
    : null;
}

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

function jsonError(error: unknown, fallbackStatus: number): Response {
  const message = error instanceof Error ? error.message : "Request failed";
  return Response.json({ error: message }, { status: fallbackStatus });
}
