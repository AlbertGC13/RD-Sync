import { resolvePrincipal, requireRole } from "../../../../modules/auth";
import { InMemoryRateLimiter } from "../../../../modules/auth/rate-limiter";
import {
  authorizeManualRecoveryResolution,
  type ManualRecoveryResolutionDecision,
  type ManualRecoveryResolutionRateLimitGate,
} from "../../../../modules/bank-sessions/manual-recovery-resolution";
import type { BankSessionExpiryEpisodeRepository } from "../../../../modules/bank-sessions/expiry-episodes";
import { getPrismaClient } from "../../../../modules/persistence/prisma-client";
import { PrismaBankSessionExpiryEpisodeRepository } from "../../../../modules/persistence/prisma-bank-session-expiry-episode-repository";

interface ManualRecoveryHandlerDeps {
  episodes: Pick<BankSessionExpiryEpisodeRepository, "findByBankCode" | "resolveConsumerManualRecovery">;
  rateLimitGate: ManualRecoveryResolutionRateLimitGate;
}

const rateLimiter = new InMemoryRateLimiter({ maxAttempts: 10, windowMs: 60_000 });
const defaultRateLimitGate: ManualRecoveryResolutionRateLimitGate = {
  async allow(operatorId) {
    const key = `manual-recovery:${operatorId}`;
    const result = rateLimiter.check(key);
    if (result.allowed) rateLimiter.recordFailure(key);
    return result.allowed;
  },
};

function defaultDependencies(): ManualRecoveryHandlerDeps {
  return {
    episodes: new PrismaBankSessionExpiryEpisodeRepository(getPrismaClient()),
    rateLimitGate: defaultRateLimitGate,
  };
}

function createManualRecoveryHandler(provided?: ManualRecoveryHandlerDeps) {
  return async function handleManualRecovery(request: Request): Promise<Response> {
    const principal = resolvePrincipal(request);
    try {
      requireRole(principal, ["admin"]);
    } catch {
      return Response.json({ error: principal ? "Forbidden" : "Authentication required" }, { status: principal ? 403 : 401 });
    }

    const bankCode = new URL(request.url).searchParams.get("bankCode")?.trim();
    if (!bankCode) return Response.json({ error: "bankCode is required" }, { status: 400 });

    let dependencies: ManualRecoveryHandlerDeps;
    try {
      dependencies = provided ?? defaultDependencies();
      const episode = await dependencies.episodes.findByBankCode(bankCode);
      const eligible = episode?.consumerAttemptState === "manual_recovery_required"
        && Boolean(episode.publicationClaimToken?.trim())
        && Boolean(episode.consumerClaimToken?.trim());

      if (request.method === "GET") return Response.json({ eligible });
      if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
      if (!eligible || !episode) return Response.json({ error: "No manual recovery is available" }, { status: 409 });

      const body = await readBody(request);
      const command = await authorizeManualRecoveryResolution({
        actor: { operatorId: principal!.id, roles: [principal!.role] },
        decision: body.decision as ManualRecoveryResolutionDecision,
      }, dependencies.rateLimitGate);
      const resolution = await dependencies.episodes.resolveConsumerManualRecovery({
        bankCode: episode.bankCode,
        expiredEventId: episode.expiredEventId,
        runId: episode.runId,
        token: episode.publicationClaimToken!,
      }, episode.consumerClaimToken!, command);

      return resolution
        ? Response.json({ status: "resolved" })
        : Response.json({ error: "No manual recovery is available" }, { status: 409 });
    } catch (error) {
      if (error instanceof Error && (error.message === "Manual recovery decision is invalid" || error.message === "Manual recovery resolution rate limited")) {
        return Response.json({ error: "Invalid manual recovery request" }, { status: 400 });
      }
      console.error("[bank-sessions/manual-recovery] request failed", { bankCode, error: error instanceof Error ? error.name : "unknown" });
      return Response.json({ error: "Manual recovery is unavailable" }, { status: 503 });
    }
  };
}

async function readBody(request: Request): Promise<{ decision?: unknown }> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body as { decision?: unknown } : {};
  } catch {
    return {};
  }
}

export const GET = createManualRecoveryHandler();
export const POST = createManualRecoveryHandler();
