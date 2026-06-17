import { createAuditEvent, type AuditSink } from "../../../../../modules/audit";
import { requireRole, resolvePrincipal } from "../../../../../modules/auth";
import {
  type InMemoryTransactionRepository,
  type ReviewState,
  toDashboardTransaction,
} from "../../../../../modules/transactions";
import { defaultAuditSink, defaultTransactionRepository, seedE2ETransactionFixturesIfEnabled } from "../../defaults";

interface ReviewRouteDependencies {
  repository: Pick<InMemoryTransactionRepository, "updateReviewState">;
  auditSink: Pick<AuditSink, "record">;
  beforeWrite?: () => Promise<void>;
}

interface ReviewRouteContext {
  params: Promise<{ id: string }> | { id: string };
}

const defaultDependencies: ReviewRouteDependencies = {
  repository: defaultTransactionRepository,
  auditSink: defaultAuditSink,
  beforeWrite: seedE2ETransactionFixturesIfEnabled,
};

const allowedReviewStates = new Set<ReviewState>(["seen", "internally_validated", "ignored", "needs_review"]);

export function createPatchTransactionReviewHandler(dependencies: ReviewRouteDependencies) {
  return async function patchTransactionReview(request: Request, context: ReviewRouteContext): Promise<Response> {
    const principal = resolvePrincipal(request);

    let authorizedPrincipal;
    try {
      authorizedPrincipal = requireRole(principal, ["reviewer", "admin"]);
    } catch (error) {
      return jsonError(error, principal ? 403 : 401);
    }

    const { id } = await Promise.resolve(context.params);
    const payload = (await request.json()) as { reviewState?: ReviewState };

    if (!payload.reviewState || !allowedReviewStates.has(payload.reviewState)) {
      return Response.json({ error: "Invalid reviewState" }, { status: 400 });
    }

    await dependencies.beforeWrite?.();

    const transaction = await dependencies.repository.updateReviewState(id, payload.reviewState, authorizedPrincipal.id);
    if (!transaction) {
      return Response.json({ error: "Transaction not found" }, { status: 404 });
    }

    await dependencies.auditSink.record(
      createAuditEvent({
        actorId: authorizedPrincipal.id,
        actorRole: authorizedPrincipal.role,
        action: "transaction.reviewed",
        target: "transaction",
        targetId: id,
        metadata: { reviewState: payload.reviewState },
      }),
    );

    return Response.json({ transaction: toDashboardTransaction(transaction) });
  };
}

export const PATCH = createPatchTransactionReviewHandler(defaultDependencies);

function jsonError(error: unknown, fallbackStatus: number): Response {
  const message = error instanceof Error ? error.message : "Request failed";
  return Response.json({ error: message }, { status: fallbackStatus });
}
