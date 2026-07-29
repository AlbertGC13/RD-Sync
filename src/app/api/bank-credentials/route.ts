import { resolvePrincipal, requireRole } from "../../../modules/auth";
import type { RateLimiter } from "../../../modules/auth/rate-limiter";
import { InMemoryRateLimiter } from "../../../modules/auth/rate-limiter";
import type { BankCredentialService } from "../../../modules/bank-credentials/service";
import { BankAutoLoginConfigRepository } from "../../../modules/bank-auto-login-config/repository";
import { getPrismaClient } from "../../../modules/persistence/prisma-client";
import { getDefaultBankCredentialService } from "./defaults";

export interface GetBankCredentialsHandlerDeps {
  service: Pick<BankCredentialService, "getMetadata">;
  autoLoginConfigs: Pick<BankAutoLoginConfigRepository, "getByBankCode">;
}

export interface PostBankCredentialsHandlerDeps {
  service: Pick<BankCredentialService, "setOrRotate" | "validateStoredCredentialDecryption">;
  rateLimiter?: RateLimiter;
}

export function createGetBankCredentialsHandler(deps?: GetBankCredentialsHandlerDeps) {
  return async function getBankCredentials(request: Request): Promise<Response> {
    const principal = resolvePrincipal(request);

    try {
      requireRole(principal, ["admin"]);
    } catch {
      return Response.json(
        { error: principal ? "Forbidden" : "Authentication required" },
        { status: principal ? 403 : 401 },
      );
    }

    const url = new URL(request.url);
    const bankCode = url.searchParams.get("bankCode");

    if (!bankCode || !bankCode.trim()) {
      return Response.json(
        { error: "bankCode query parameter is required" },
        { status: 400 },
      );
    }

    const trimmedBankCode = bankCode.trim();
    let resolvedDeps = deps;

    if (!resolvedDeps) {
      try {
        resolvedDeps = { service: getDefaultBankCredentialService(), autoLoginConfigs: new BankAutoLoginConfigRepository(getPrismaClient()) };
      } catch (error) {
        logGetCredentialMetadataFailure(trimmedBankCode, error);
        return Response.json(
          { error: "Unable to retrieve credential metadata" },
          { status: 503 },
        );
      }
    }

    try {
      const [metadata, autoLoginConfig] = await Promise.all([
        resolvedDeps.service.getMetadata(trimmedBankCode),
        resolvedDeps.autoLoginConfigs.getByBankCode(trimmedBankCode),
      ]);

      if (!metadata) {
        return Response.json(
          { error: "No credentials configured for this bank" },
          { status: 404 },
        );
      }

      return Response.json({ ...metadata, autoLoginEnabled: autoLoginConfig?.autoLoginEnabled ?? false });
    } catch (error) {
      logGetCredentialMetadataFailure(trimmedBankCode, error);
      return Response.json(
        { error: "Unable to retrieve credential metadata" },
        { status: 503 },
      );
    }
  };
}

function logGetCredentialMetadataFailure(bankCode: string, error: unknown): void {
  console.error("[bank-credentials] GET failed", {
    route: "GET /api/bank-credentials",
    bankCode,
    error: getSafeErrorDiagnostic(error),
  });
}

function getSafeErrorDiagnostic(error: unknown): { name?: string; code?: string } {
  const diagnostic: { name?: string; code?: string } = {};

  if (error instanceof Error && isSafeDiagnosticToken(error.name)) {
    diagnostic.name = error.name;
  }

  const code = getErrorCode(error);
  if (code !== undefined && isSafeDiagnosticToken(code)) {
    diagnostic.code = code;
  }

  return diagnostic;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") return String(code);

  return undefined;
}

function isSafeDiagnosticToken(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value)
    && !/(secret|token|key|password|credential|database|url|uri|connection)/i.test(value);
}

export const GET = createGetBankCredentialsHandler();

type PostAction = "set" | "rotate" | "test";

const POST_RATE_LIMIT_MAX_ATTEMPTS = 10;
const POST_RATE_LIMIT_WINDOW_MS = 60_000;

const defaultPostRateLimiter = new InMemoryRateLimiter({ maxAttempts: POST_RATE_LIMIT_MAX_ATTEMPTS, windowMs: POST_RATE_LIMIT_WINDOW_MS });

export function createPostBankCredentialsHandler(deps?: PostBankCredentialsHandlerDeps) {
  return async function postBankCredentials(request: Request): Promise<Response> {
    const principal = resolvePrincipal(request);

    try {
      requireRole(principal, ["admin"]);
    } catch {
      return Response.json({ error: principal ? "Forbidden" : "Authentication required" }, { status: principal ? 403 : 401 });
    }

    const rateLimiter = deps?.rateLimiter ?? defaultPostRateLimiter;
    const rateKey = `post:${principal!.id}`;
    const rateResult = rateLimiter.check(rateKey);

    if (!rateResult.allowed) {
      const headers = rateResult.retryAfterSeconds ? { "Retry-After": String(rateResult.retryAfterSeconds) } : undefined;
      return Response.json({ error: "Rate limit exceeded" }, { status: 429, headers });
    }

    recordPostAttempt(rateLimiter, rateKey);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!isPostBody(body)) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const bankCode = typeof body.bankCode === "string" ? body.bankCode.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (!bankCode) {
      return Response.json({ error: "bankCode is required" }, { status: 400 });
    }

    if (!action || !isPostAction(action)) {
      return Response.json({ error: "action is required (set, rotate, or test)" }, { status: 400 });
    }

    const username = body.username;
    const password = body.password;
    let credentialInput: { username: string; password: string } | undefined;

    if (action === "set" || action === "rotate") {
      if (!isNonBlankString(username) || !isNonBlankString(password)) {
        return Response.json({ error: "username and password are required for set/rotate" }, { status: 400 });
      }
      credentialInput = { username, password };
    }

    let resolvedDeps = deps;
    if (!resolvedDeps) {
      try {
        resolvedDeps = { service: getDefaultBankCredentialService() };
      } catch (error) {
        logPostFailure(bankCode, action, error);
        return Response.json({ error: "Service unavailable" }, { status: 503 });
      }
    }

    try {
      if (credentialInput) {
        const result = await resolvedDeps.service.setOrRotate({ bankCode, ...credentialInput }, principal!.id);
        return Response.json({
          message: "Credenciales actualizadas",
          bankCode: result.bankCode,
          action: result.action,
          keyVersion: result.keyVersion,
        });
      }

      // action === "test"
      const result = await resolvedDeps.service.validateStoredCredentialDecryption(bankCode, principal!.id);
      return Response.json(result);
    } catch (error) {
      logPostFailure(bankCode, action, error);
      return Response.json({ error: "Unable to process credential request" }, { status: 503 });
    }
  };
}

function isPostAction(value: string): value is PostAction {
  return value === "set" || value === "rotate" || value === "test";
}

function isPostBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function recordPostAttempt(rateLimiter: RateLimiter, rateKey: string): void {
  rateLimiter.recordFailure(rateKey);
}

function logPostFailure(bankCode: string, action: string, error: unknown): void {
  console.error("[bank-credentials] POST failed", {
    route: "POST /api/bank-credentials",
    bankCode,
    action,
    error: getSafeErrorDiagnostic(error),
  });
}

export const POST = createPostBankCredentialsHandler();
