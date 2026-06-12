import {
  InMemoryTransactionRepository,
  normalizeBankMovement,
  toDashboardTransaction,
  type DashboardTransaction,
  type TransactionFilters,
} from "../../../modules/transactions";
import { defaultAuditSink } from "../audit/defaults";

export { defaultAuditSink };

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncTransactionRepository?: InMemoryTransactionRepository;
};

export const defaultTransactionRepository =
  (globalRegistry.__rdSyncTransactionRepository ??= new InMemoryTransactionRepository());

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
 * route group call this so they render real data through the same in-memory
 * repository the API route uses. The page-level read deliberately bypasses the
 * API layer because (a) it is a server component (no HTTP roundtrip needed)
 * and (b) authorization happens at the layout / trusted-header level, not here.
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
