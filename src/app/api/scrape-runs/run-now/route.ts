import { resolvePrincipal } from "../../../../modules/auth";
import type { InMemoryIngestionConsumer } from "../../../../worker/ingestion-consumer";
import { resolveDefaultIngestionConsumer } from "../consumer-selection";

const SAFE_MESSAGE = "Unable to schedule run";

type RouteRuntime = typeof import("./route-runtime");

let runtimePending: Promise<RouteRuntime> | undefined;

function loadRuntime(): Promise<RouteRuntime> {
  runtimePending ??= import("./route-runtime").catch((error: unknown) => {
    runtimePending = undefined;
    throw error;
  });
  return runtimePending;
}

/** Lightweight auth and activation gate. Heavy scheduling code is loaded only after it passes. */
export async function POST(request: Request): Promise<Response> {
  const principal = resolvePrincipal(request);
  if (!principal) return Response.json({ error: SAFE_MESSAGE }, { status: 401 });

  let consumer: InMemoryIngestionConsumer | undefined;
  try {
    consumer = await resolveDefaultIngestionConsumer();
    const runtime = await loadRuntime();
    return runtime.postDefaultScrapeRunNow(request, consumer);
  } catch (error) {
    console.error("[run-now] failed to load scheduling runtime", {
      actorId: principal.id,
      actorRole: principal.role,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    return Response.json({ error: SAFE_MESSAGE }, { status: 503 });
  }
}
