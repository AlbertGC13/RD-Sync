import { requireRole, resolvePrincipal, type Principal } from "../../../../../modules/auth";
import { InMemoryRateLimiter, type RateLimiter } from "../../../../../modules/auth/rate-limiter";
import { isSupportedRunNowBankCode } from "../../../../../lib/banks";
import { defaultSetAutoLoginEnabledAndAudit, type SetAutoLoginEnabledAndAudit } from "./defaults";

const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const defaultRateLimiter = new InMemoryRateLimiter({ maxAttempts: RATE_LIMIT_MAX_ATTEMPTS, windowMs: RATE_LIMIT_WINDOW_MS });

export interface PatchAutoLoginHandlerDeps {
  setAutoLoginEnabledAndAudit: SetAutoLoginEnabledAndAudit;
  rateLimiter?: RateLimiter;
  supportedBankCodes?: readonly string[];
  reportAtomicToggleFailure?: (signal: AtomicToggleFailure) => void | Promise<void>;
}

interface AtomicToggleFailure {
  requestId: string;
  bankCode: string;
  attemptedEnabled: boolean;
  stage: "atomic_toggle_failed";
}

export function createPatchAutoLoginHandler(deps?: PatchAutoLoginHandlerDeps) {
  const rateLimiter = deps?.rateLimiter ?? defaultRateLimiter;
  const supportedBankCodes = deps?.supportedBankCodes ?? null;
  const reportAtomicToggleFailure = deps?.reportAtomicToggleFailure ?? defaultReportAtomicToggleFailure;

  return async function patchAutoLogin(request: Request, rawBankCode: string): Promise<Response> {
    const resolvedPrincipal = resolvePrincipal(request);
    let principal: Principal;
    try {
      principal = requireRole(resolvedPrincipal, ["admin"]);
    } catch {
      return Response.json({ error: resolvedPrincipal ? "Forbidden" : "Authentication required" }, { status: resolvedPrincipal ? 403 : 401 });
    }

    const bankCode = normalizeBankCode(rawBankCode);
    const rateKey = `patch:auto-login:${principal.id}`;
    const rateResult = rateLimiter.check(rateKey);
    if (!rateResult.allowed) {
      const headers = rateResult.retryAfterSeconds ? { "Retry-After": String(rateResult.retryAfterSeconds) } : undefined;
      return Response.json({ error: "Rate limit exceeded" }, { status: 429, headers });
    }
    rateLimiter.recordFailure(rateKey);

    const enabled = await readEnabled(request);
    if (enabled === null) return Response.json({ error: "Invalid request body" }, { status: 400 });
    if (!bankCode || !(supportedBankCodes ?? []).includes(bankCode) && !isSupportedRunNowBankCode(bankCode)) {
      return Response.json({ error: "Bank configuration not found" }, { status: 404 });
    }

    try {
      const result = await (deps?.setAutoLoginEnabledAndAudit ?? defaultSetAutoLoginEnabledAndAudit)({ bankCode, enabled, adminId: principal.id });
      if (!result) return Response.json({ error: "Auto-login configuration not found" }, { status: 404 });
      return Response.json(result);
    } catch {
      await reportFailure(reportAtomicToggleFailure, bankCode, enabled);
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }
  };
}

export async function PATCH(request: Request, context: { params: Promise<{ bankCode: string }> }): Promise<Response> {
  const { bankCode } = await context.params;
  return createPatchAutoLoginHandler()(request, bankCode);
}

async function readEnabled(request: Request): Promise<boolean | null> {
  try {
    const body: unknown = await request.json();
    if (!isExactEnabledBody(body)) return null;
    return body.enabled;
  } catch {
    return null;
  }
}

function isExactEnabledBody(value: unknown): value is { enabled: boolean } {
  const body = value as Record<string, unknown>;
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 1
    && Object.keys(value)[0] === "enabled"
    && typeof body.enabled === "boolean";
}

function normalizeBankCode(rawBankCode: string): string {
  try {
    return decodeURIComponent(rawBankCode).trim();
  } catch {
    return "";
  }
}

async function reportFailure(reporter: (signal: AtomicToggleFailure) => void | Promise<void>, bankCode: string, attemptedEnabled: boolean): Promise<void> {
  try {
    await reporter({ requestId: crypto.randomUUID(), bankCode, attemptedEnabled, stage: "atomic_toggle_failed" });
  } catch {
    // Reporting must not replace the safe HTTP failure.
  }
}

function defaultReportAtomicToggleFailure(signal: AtomicToggleFailure): void {
  console.error(signal);
}
