import { InMemoryAuditSink, createAuditEvent } from "../../../../../modules/audit";
import { requireRole, resolvePrincipalFromTrustedHeaders } from "../../../../../modules/auth";
import {
  InMemoryTransactionRepository,
  type ReviewState,
  toDashboardTransaction,
} from "../../../../../modules/transactions";

interface ReviewRouteDependencies {
  repository: Pick<InMemoryTransactionRepository, "updateReviewState">;
  auditSink: Pick<InMemoryAuditSink, "record">;
}

interface ReviewRouteContext {
  params: Promise<{ id: string }> | { id: string };
}

const defaultDependencies: ReviewRouteDependencies = {
  repository: new InMemoryTransactionRepository(),
  auditSink: new InMemoryAuditSink(),
};

const allowedReviewStates = new Set<ReviewState>(["seen", "internally_validated", "ignored", "needs_review"]);

export function createPatchTransactionReviewHandler(dependencies: ReviewRouteDependencies) {
  return async function patchTransactionReview(request: Request, context: ReviewRouteContext): Promise<Response> {
    const principal = resolvePrincipalFromTrustedHeaders(request.headers);

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
