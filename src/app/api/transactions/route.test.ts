import { describe, expect, it } from "vitest";

import { InMemoryAuditSink } from "../../../modules/audit";
import { InMemoryTransactionRepository, normalizeBankMovement } from "../../../modules/transactions";
import { createGetTransactionsHandler } from "./route";

describe("GET /api/transactions", () => {
  it("denies unauthenticated requests", async () => {
    const handler = createGetTransactionsHandler({
      auditSink: new InMemoryAuditSink(),
      repository: new InMemoryTransactionRepository(),
    });

    const response = await handler(new Request("http://localhost/api/transactions"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  it("returns filtered minimized transactions and writes an audit event", async () => {
    const auditSink = new InMemoryAuditSink();
    const repository = new InMemoryTransactionRepository();
    await repository.upsertMany([
      normalizeBankMovement(
        {
          bankId: "popular",
          accountFingerprint: "acct-main",
          postedAt: "2026-06-07T09:45:00-04:00",
          amount: "1500.50",
          currency: "DOP",
          direction: "credit",
          reference: "REF-123",
          concept: "Pago factura 1001",
          originator: "Cliente Uno",
          metadata: { rawHtml: "secret" },
        },
        { id: "tx-1" },
      ),
    ]);
    const request = new Request("http://localhost/api/transactions?bankId=popular&query=factura", {
      headers: {
        "x-rd-sync-user-id": "viewer-1",
        "x-rd-sync-role": "viewer",
      },
    });
    const handler = createGetTransactionsHandler({ auditSink, repository });

    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.transactions).toEqual([
      expect.objectContaining({ id: "tx-1", bankId: "popular", amount: "1500.50" }),
    ]);
    expect(body.transactions[0]).not.toHaveProperty("metadata");
    expect(body.transactions[0]).not.toHaveProperty("sourceHash");
    expect(await auditSink.list()).toEqual([
      expect.objectContaining({
        actorId: "viewer-1",
        action: "transactions.filtered",
        target: "transaction",
      }),
    ]);
  });
});
