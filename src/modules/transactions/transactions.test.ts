import { describe, expect, it } from "vitest";

import {
  createSourceHash,
  filterTransactions,
  InMemoryTransactionRepository,
  normalizeBankMovement,
  toDashboardTransaction,
} from "./index";
import type { BankMovement, TransactionRecord } from "./index";

const baseMovement: BankMovement = {
  bankId: "popular",
  accountFingerprint: "acct-main",
  postedAt: "2026-06-07T09:45:00-04:00",
  amount: "1500.50",
  currency: "DOP",
  direction: "credit",
  reference: "REF-123",
  concept: "Pago factura 1001",
  originator: "Cliente Uno",
};

describe("normalizeBankMovement", () => {
  it("normalizes available bank movement fields into a canonical record", () => {
    const record = normalizeBankMovement(baseMovement);

    expect(record).toMatchObject({
      bankId: "popular",
      accountFingerprint: "acct-main",
      amount: "1500.50",
      currency: "DOP",
      direction: "credit",
      reference: "REF-123",
      concept: "Pago factura 1001",
      originator: "Cliente Uno",
      reviewState: "new",
    });
    expect(record.postedAt.toISOString()).toBe("2026-06-07T13:45:00.000Z");
    expect(record.sourceHash).toBe(createSourceHash(record));
  });

  it("keeps optional fields empty without blocking ingestion", () => {
    const record = normalizeBankMovement({
      bankId: "bhd",
      accountFingerprint: "acct-secondary",
      postedAt: "2026-06-07T10:00:00-04:00",
      amount: 300,
      currency: "DOP",
      direction: "credit",
    });

    expect(record.reference).toBeNull();
    expect(record.concept).toBeNull();
    expect(record.originator).toBeNull();
    expect(record.sourceHash).toContain("sha256:");
  });
});

describe("filterTransactions", () => {
  const records: TransactionRecord[] = [
    normalizeBankMovement(baseMovement, { id: "tx-1" }),
    normalizeBankMovement(
      {
        ...baseMovement,
        bankId: "bhd",
        amount: "2750.00",
        reference: "BHD-999",
        concept: "Reserva evento",
        originator: "Cliente Dos",
      },
      { id: "tx-2" },
    ),
  ];

  it("returns newest-first records matching payment filters", () => {
    const result = filterTransactions(records, {
      bankId: "bhd",
      amount: "2750.00",
      query: "reserva",
    });

    expect(result.map((record) => record.id)).toEqual(["tx-2"]);
  });

  it("returns an empty result for non-matching filters after evaluating data", () => {
    const result = filterTransactions(records, {
      bankId: "popular",
      query: "not-present",
    });

    expect(result).toEqual([]);
  });
});

describe("toDashboardTransaction", () => {
  it("removes metadata and internal fields from dashboard output", () => {
    const record = normalizeBankMovement(baseMovement, {
      id: "tx-1",
      metadata: { rawHtml: "secret", balanceAfter: "999999" },
    });

    expect(toDashboardTransaction(record)).toEqual({
      id: "tx-1",
      bankId: "popular",
      accountFingerprint: "acct-main",
      postedAt: record.postedAt.toISOString(),
      amount: "1500.50",
      currency: "DOP",
      direction: "credit",
      reference: "REF-123",
      concept: "Pago factura 1001",
      originator: "Cliente Uno",
      reviewState: "new",
      reviewedAt: null,
    });
  });
});
describe("InMemoryTransactionRepository", () => {
  it("upserts by sourceHash and reports skipped duplicates", async () => {
    const repository = new InMemoryTransactionRepository();
    const record = normalizeBankMovement(baseMovement, { id: "tx-1" });

    const first = await repository.upsertMany([record]);
    const second = await repository.upsertMany([{ ...record, id: "tx-duplicate" }]);

    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    expect(await repository.list({})).toHaveLength(1);
  });
});


