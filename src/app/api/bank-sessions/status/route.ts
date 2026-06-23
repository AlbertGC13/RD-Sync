import { resolvePrincipal, requireRole } from "../../../../modules/auth";
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

const BROWSER_UNAVAILABLE_SUMMARY = "Bank browser session is not available";

export function createGetBankSessionStatusHandler(
  deps: BankSessionStatusHandlerDeps = defaultDeps,
) {
  return async function getBankSessionStatus(request: Request): Promise<Response> {
    // Backend authz is the ONLY path to admin: a signed session cookie or
    // RD_SYNC_TRUST_PROXY_HEADERS-enabled headers. There is no query-param
    // bypass.
    const principal = resolvePrincipal(request);

    try {
      requireRole(principal, ["admin"]);
    } catch {
      return Response.json(
        { error: "Admin role required" },
        { status: principal ? 403 : 401 },
      );
    }

    // Degrade, do not hard-fail, when the checker throws unexpectedly. The
    // CDP-backed implementation already converts connect failures into a
    // browser_unavailable result, but unexpected exceptions (timeout, OOM,
    // misconfigured deps) must not take down the admin endpoint.
    let session: BankSessionCheckResult;
    try {
      session = await deps.checker.check();
    } catch (error) {
      // principal is guaranteed non-null here: requireRole above already
      // returned or thrown.
      const actor = principal as { id: string; role: "admin" | "reviewer" | "viewer" };
      console.error("[bank-sessions/status] checker threw unexpectedly", {
        actorId: actor.id,
        actorRole: actor.role,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
      });
      session = {
        status: "browser_unavailable",
        // Use the current failure timestamp, NOT a false epoch. A `checkedAt`
        // of 1970-01-01 would mislead operators into thinking the session was
        // last checked at the Unix epoch and could mask a stale/unhealthy
        // checker behind a seemingly-old timestamp.
        checkedAt: new Date().toISOString(),
        safeSummary: BROWSER_UNAVAILABLE_SUMMARY,
      };
    }

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
