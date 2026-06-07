import { InMemoryAuditSink } from "../../../modules/audit";
import { InMemoryTransactionRepository, normalizeBankMovement } from "../../../modules/transactions";

export const defaultTransactionRepository = new InMemoryTransactionRepository();
export const defaultAuditSink = new InMemoryAuditSink();

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
