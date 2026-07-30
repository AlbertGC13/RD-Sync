import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { InMemoryAuditSink } from "../modules/audit";
import { BANK_AUTOLOGIN_ACTIONS } from "../modules/audit/bank-actions";
import { createProductionAutoLoginOutcomeHook } from "./auto-login-composition";

describe("ingestion worker auto-login composition", () => {
  it("records exactly one canonical event for every typed runner outcome", async () => {
    const auditSink = new InMemoryAuditSink();
    const afterAutoLoginOutcome = createProductionAutoLoginOutcomeHook(auditSink);
    const metadata = { bankCode: "popular", expiredEventId: "expired-1", runId: "run-1" };

    await afterAutoLoginOutcome({ ...metadata, outcome: { status: "succeeded" } });
    await afterAutoLoginOutcome({ ...metadata, outcome: { status: "needs_admin_action", reason: "protected_flow", safeSummary: "Bank auto-login requires admin action" } });
    await afterAutoLoginOutcome({ ...metadata, outcome: { status: "manual_required", reason: "lock_busy", safeSummary: "Manual scrape required before retrying bank auto-login" } });
    await afterAutoLoginOutcome({ ...metadata, outcome: { status: "throttled", safeSummary: "Bank browser capacity is temporarily unavailable" } });

    const events = await auditSink.list();

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.action).sort()).toEqual([
      BANK_AUTOLOGIN_ACTIONS.NEEDS_ADMIN_ACTION,
      BANK_AUTOLOGIN_ACTIONS.SKIPPED,
      BANK_AUTOLOGIN_ACTIONS.SKIPPED,
      BANK_AUTOLOGIN_ACTIONS.SUCCEEDED,
    ].sort());
    expect(events.map((event) => event.metadata)).toEqual(expect.arrayContaining([
      { bankCode: "popular", expiredEventId: "expired-1", runId: "run-1", reason: "succeeded" },
      { bankCode: "popular", expiredEventId: "expired-1", runId: "run-1", reason: "protected_flow" },
      { bankCode: "popular", expiredEventId: "expired-1", runId: "run-1", reason: "lock_busy" },
      { bankCode: "popular", expiredEventId: "expired-1", runId: "run-1", reason: "throttled" },
    ]));
  });

  it("uses the production outcome hook from the real worker composition root", async () => {
    const workerSource = await readFile(new URL("./ingestion-worker.ts", import.meta.url), "utf8");

    expect(workerSource).toContain("afterAutoLoginOutcome: createProductionAutoLoginOutcomeHook(defaultAuditSink)");
  });
});
