import { resolvePrincipalFromTrustedHeaders, requireRole } from "../../../../modules/auth";
import type { CdpSessionChecker, BankSessionCheckResult, BankSessionMonitor } from "../../../../modules/bank-sessions";
import {
  defaultSessionChecker,
  defaultSessionMonitor,
  startDefaultSessionMonitorIfEnabled,
} from "../defaults";

// Start the background monitor when this module is first imported.
startDefaultSessionMonitorIfEnabled();

// ---------------------------------------------------------------------------
// Handler factory (injectable dependencies for testing)
// ---------------------------------------------------------------------------

export interface BankSessionStatusHandlerDeps {
  checker: CdpSessionChecker;
  monitor: BankSessionMonitor | null;
}

const defaultDeps: BankSessionStatusHandlerDeps = {
  checker: defaultSessionChecker,
  monitor: defaultSessionMonitor,
};

export function createGetBankSessionStatusHandler(
  deps: BankSessionStatusHandlerDeps = defaultDeps,
) {
  return async function getBankSessionStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const principal =
      resolveApiPreviewPrincipal(url.searchParams) ??
      resolvePrincipalFromTrustedHeaders(request.headers);

    try {
      requireRole(principal, ["admin"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Forbidden";
      return Response.json(
        { error: message },
        { status: principal ? 403 : 401 },
      );
    }

    // Perform a live check.
    const session: BankSessionCheckResult = await deps.checker.check();

    return Response.json({
      session,
      monitor: {
        enabled: deps.monitor !== null,
        lastResult: deps.monitor?.lastResult() ?? null,
      },
    });
  };
}

export const GET = createGetBankSessionStatusHandler(defaultDeps);

// ---------------------------------------------------------------------------
// resolveApiPreviewPrincipal — matches run-now route pattern exactly
// ---------------------------------------------------------------------------

export function resolveApiPreviewPrincipal(
  searchParams: URLSearchParams,
): { id: string; role: "admin" } | null {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.RD_SYNC_DEV_PREVIEW !== "enabled"
  ) {
    return null;
  }

  return searchParams.get("previewRole") === "admin"
    ? { id: "admin-preview", role: "admin" }
    : null;
}
