import { resolvePrincipal, requireRole } from "../../../modules/auth";
import type { BankCredentialService } from "../../../modules/bank-credentials/service";
import { getDefaultBankCredentialService } from "./defaults";

export interface BankCredentialsHandlerDeps {
  service: Pick<BankCredentialService, "getMetadata">;
}

function getDefaultDeps(): BankCredentialsHandlerDeps {
  return {
    service: getDefaultBankCredentialService(),
  };
}

export function createGetBankCredentialsHandler(deps?: BankCredentialsHandlerDeps) {
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
    let d = deps;

    if (!d) {
      try {
        d = getDefaultDeps();
      } catch (error) {
        logGetCredentialMetadataFailure(trimmedBankCode, error);
        return Response.json(
          { error: "Unable to retrieve credential metadata" },
          { status: 503 },
        );
      }
    }

    try {
      const metadata = await d.service.getMetadata(trimmedBankCode);

      if (!metadata) {
        return Response.json(
          { error: "No credentials configured for this bank" },
          { status: 404 },
        );
      }

      return Response.json(metadata);
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
