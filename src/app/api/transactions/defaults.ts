/**
 * Default transaction repository singleton.
 *
 * Env-switch: When DATABASE_URL is set (read at module-load time, consistent
 * with the existing pattern), the Prisma-backed repository is used instead of
 * the in-memory one. Both implementations satisfy the same interface so no
 * consumer code changes are required.
 *
 * The instance is anchored on globalThis so that Next.js dev module-graph
 * hot-reloads and multiple module graphs within the same process share a
 * single instance.
 */

import {
  InMemoryTransactionRepository,
  normalizeBankMovement,
  toDashboardTransaction,
  type DashboardTransaction,
  type TransactionFilters,
} from "../../../modules/transactions/index";
import { PrismaTransactionRepository } from "../../../modules/persistence/prisma-transaction-repository";
import { defaultAuditSink } from "../audit/defaults";

export { defaultAuditSink };

type AnyTransactionRepository = InMemoryTransactionRepository | PrismaTransactionRepository;

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncTransactionRepository?: AnyTransactionRepository;
};

function createTransactionRepository(): AnyTransactionRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaTransactionRepository();
  }
  return new InMemoryTransactionRepository();
}

export const defaultTransactionRepository: AnyTransactionRepository =
  (globalRegistry.__rdSyncTransactionRepository ??= createTransactionRepository());

let e2eFixturesSeeded = false;

export async function seedE2ETransactionFixturesIfEnabled() {
  if (process.env.RD_SYNC_E2E_FIXTURES !== "enabled" || e2eFixturesSeeded) {
    return;
  }

  e2eFixturesSeeded = true;

  await defaultTransactionRepository.upsertMany([
    normalizeBankMovement(
      {
        bankId: "popular",
        accountFingerprint: "acct-e2e",
        postedAt: "2026-06-07T09:45:00-04:00",
        amount: "1500.50",
        currency: "DOP",
        direction: "credit",
        reference: "E2E-REF-001",
        concept: "Pago factura E2E",
        originator: "Cliente E2E",
      },
      { id: "tx-e2e-review" },
    ),
  ]);
}

/**
 * Read transactions for the dashboard page. Server components in the (private)
 * route group call this so they render real data through the same repository
 * the API route uses. The page-level read deliberately bypasses the API layer
 * because (a) it is a server component (no HTTP roundtrip needed) and (b)
 * authorization happens at the layout / trusted-header level, not here.
 *
 * @param filters - the FR-010 filter set
 * @returns dashboard-shaped transactions (no sourceHash, no metadata)
 */
export async function listTransactionsForPage(
  filters: TransactionFilters,
): Promise<DashboardTransaction[]> {
  await seedE2ETransactionFixturesIfEnabled();
  const records = await defaultTransactionRepository.list(filters);
  return records.map(toDashboardTransaction);
}
