import { createAuditEvent, type AuditSink } from "../../../modules/audit";
import { requireRole, resolvePrincipalFromTrustedHeaders } from "../../../modules/auth";
import {
  type InMemoryTransactionRepository,
  type TransactionFilters,
  toDashboardTransaction,
} from "../../../modules/transactions";
import { defaultAuditSink, defaultTransactionRepository, seedE2ETransactionFixturesIfEnabled } from "./defaults";

interface TransactionsRouteDependencies {
  repository: Pick<InMemoryTransactionRepository, "list">;
  auditSink: Pick<AuditSink, "record">;
  beforeRead?: () => Promise<void>;
}

const defaultDependencies: TransactionsRouteDependencies = {
  repository: defaultTransactionRepository,
  auditSink: defaultAuditSink,
  beforeRead: seedE2ETransactionFixturesIfEnabled,
};

export function createGetTransactionsHandler(dependencies: TransactionsRouteDependencies) {
  return async function getTransactions(request: Request): Promise<Response> {
    const principal = resolvePrincipalFromTrustedHeaders(request.headers);

    let authorizedPrincipal;
    try {
      authorizedPrincipal = requireRole(principal, ["viewer", "reviewer", "admin"]);
    } catch (error) {
      return jsonError(error, 401);
    }

    await dependencies.beforeRead?.();

    const filters = parseTransactionFilters(new URL(request.url).searchParams);
    const records = await dependencies.repository.list(filters);
    const transactions = records.map(toDashboardTransaction);

    await dependencies.auditSink.record(
      createAuditEvent({
        actorId: authorizedPrincipal.id,
        actorRole: authorizedPrincipal.role,
        action: "transactions.filtered",
        target: "transaction",
        metadata: { filters, resultCount: transactions.length },
      }),
    );

    return Response.json({ transactions });
  };
}

export const GET = createGetTransactionsHandler(defaultDependencies);

function parseTransactionFilters(searchParams: URLSearchParams): TransactionFilters {
  return {
    bankId: optionalParam(searchParams, "bankId"),
    accountFingerprint: optionalParam(searchParams, "accountFingerprint"),
    amount: optionalParam(searchParams, "amount"),
    currency: optionalParam(searchParams, "currency"),
    dateFrom: optionalParam(searchParams, "dateFrom"),
    dateTo: optionalParam(searchParams, "dateTo"),
    query: optionalParam(searchParams, "query"),
  };
}

function optionalParam(searchParams: URLSearchParams, key: string): string | undefined {
  const value = searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function jsonError(error: unknown, fallbackStatus: number): Response {
  const message = error instanceof Error ? error.message : "Request failed";
  return Response.json({ error: message }, { status: fallbackStatus });
}
