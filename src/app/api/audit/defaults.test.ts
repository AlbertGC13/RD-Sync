import { describe, expect, it } from "vitest";

import { defaultAuditSink as auditSinkFromAudit } from "./defaults";
import { defaultAuditSink as auditSinkFromTransactions } from "../transactions/defaults";

describe("defaultAuditSink singleton", () => {
  it("is the same instance whether imported from audit/defaults or transactions/defaults", () => {
    expect(auditSinkFromAudit).toBe(auditSinkFromTransactions);
  });
});
