import { describe, expect, it } from "vitest";

import { InMemoryAuditSink } from "../../../../../modules/audit";
import { InMemoryTransactionRepository, normalizeBankMovement } from "../../../../../modules/transactions";
import { createPatchTransactionReviewHandler } from "./route";

describe("PATCH /api/transactions/[id]/review", () => {
  it("denies viewer review updates", async () => {
    const handler = createPatchTransactionReviewHandler({
      auditSink: new InMemoryAuditSink(),
      repository: new InMemoryTransactionRepository(),
    });
    const request = new Request("http://localhost/api/transactions/tx-1/review", {
      method: "PATCH",
      headers: { "x-rd-sync-user-id": "viewer-1", "x-rd-sync-role": "viewer" },
      body: JSON.stringify({ reviewState: "seen" }),
    });

    const response = await handler(request, { params: Promise.resolve({ id: "tx-1" }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Role viewer is not allowed" });
  });

  it("allows reviewers to mark a transaction as seen and audits the change", async () => {
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
        },
        { id: "tx-1" },
      ),
    ]);
    const request = new Request("http://localhost/api/transactions/tx-1/review", {
      method: "PATCH",
      headers: { "x-rd-sync-user-id": "reviewer-1", "x-rd-sync-role": "reviewer" },
      body: JSON.stringify({ reviewState: "seen" }),
    });
    const handler = createPatchTransactionReviewHandler({ auditSink, repository });

    const response = await handler(request, { params: Promise.resolve({ id: "tx-1" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.transaction).toEqual(expect.objectContaining({ id: "tx-1", reviewState: "seen" }));
    expect(await auditSink.list()).toEqual([
      expect.objectContaining({
        actorId: "reviewer-1",
        action: "transaction.reviewed",
        targetId: "tx-1",
      }),
    ]);
  });
});
