import { describe, expect, it, vi } from "vitest";
import { AuthenticatedIngestionTerminalError } from "./authenticated-ingestion-delivery";
import { createAuthenticatedTerminalCompleter } from "./authenticated-ingestion-terminal-completer";

describe("createAuthenticatedTerminalCompleter", () => {
  it.each(["failed", "needs_admin_action"] as const)("persists %s and emits safe telemetry", async (status) => {
    const runs = { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) };
    const audit = { record: vi.fn(async (event: unknown) => { void event; }) }; const alerts = { notifyIngestionAttention: vi.fn(async () => {}) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns: runs, auditSink: audit, adminAlerts: alerts, now: () => new Date("2026-01-01Z") });
    await expect(complete({ runId: "run-1", bankId: "popular", status, reason: "authenticated_ingestion_disabled" })).resolves.toEqual({ status, inserted: 0, skipped: 0 });
    expect(runs[status === "failed" ? "markFailed" : "markNeedsAdminAction"]).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: `scrape_run.${status}`, metadata: expect.objectContaining({ bankId: "popular", reason: "authenticated_ingestion_disabled" }) }));
    expect(alerts.notifyIngestionAttention).toHaveBeenCalledOnce(); expect((audit.record.mock.calls[0]?.[0] as { id: string }).id).not.toContain("run-1");
  });

  it("isolates telemetry, omits absent bank data, and exposes only the fixed persistence error", async () => {
    const audit = { record: vi.fn(async () => { throw new Error("secret"); }) }; const alerts = { notifyIngestionAttention: vi.fn() };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns: { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) }, auditSink: audit, adminAlerts: alerts });
    await expect(complete({ runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" })).resolves.toMatchObject({ status: "failed" });
    expect(alerts.notifyIngestionAttention).not.toHaveBeenCalled(); expect(JSON.stringify(audit.record.mock.calls)).not.toContain("secret");
    const failing = createAuthenticatedTerminalCompleter({ scrapeRuns: { markFailed: vi.fn(async () => { throw new Error("secret"); }), markNeedsAdminAction: vi.fn() } });
    await expect(failing({ runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" })).rejects.toEqual(new AuthenticatedIngestionTerminalError());
  });
});
