import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedIngestionInvalidJobError } from "./authenticated-ingestion-delivery";
import { createAuthenticatedTerminalCompleter } from "./authenticated-ingestion-composition";
import {
  createDisabledAuthenticatedIngestionProcessor,
  resolveAuthenticatedIngestionActivation,
} from "./authenticated-ingestion-activation";

const v1 = () => ({ runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1", authentication: { version: 1, attemptId: "attempt-1" } });
const legacy = () => ({ runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1" });

function setup() {
  const complete = vi.fn(async (outcome: unknown) => ({ status: (outcome as { status: string }).status, inserted: 0, skipped: 0 }));
  return { complete, processor: createDisabledAuthenticatedIngestionProcessor({ complete }) };
}

describe("resolveAuthenticatedIngestionActivation", () => {
  it.each(["enabled", undefined, "", " ", " enabled", "enabled ", "ENABLED", "Enabled", "true", "1", "disabled", "no"])
    ("recognizes only the exact raw value %j", (raw) => {
      const result = resolveAuthenticatedIngestionActivation(raw);
      expect(result).toEqual(raw === "enabled" ? { status: "enabled" } : { status: "disabled" });
      expect(Object.isFrozen(result)).toBe(true);
    });

  it("does not mutate input or read process environment", async () => {
    const raw = new String("enabled");
    expect(resolveAuthenticatedIngestionActivation(raw as unknown as string)).toEqual({ status: "disabled" });
    expect(raw.valueOf()).toBe("enabled");
    const source = await readFile(new URL("./authenticated-ingestion-activation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env|\.trim\(|\.toLowerCase\(|\.toUpperCase\(/);
  });
});

describe("createDisabledAuthenticatedIngestionProcessor", () => {
  it("completes a V1 delivery with disabled telemetry and no owner token", async () => {
    const scrapeRuns = { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) };
    const auditSink = { record: vi.fn(async () => {}) };
    const adminAlerts = { notifyIngestionAttention: vi.fn(async () => {}) };
    const processor = createDisabledAuthenticatedIngestionProcessor({
      complete: createAuthenticatedTerminalCompleter({ scrapeRuns, auditSink, adminAlerts, now: () => new Date("2026-08-21T00:00:00.000Z") }),
    });

    await expect(processor({ data: v1() })).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(scrapeRuns.markNeedsAdminAction).toHaveBeenCalledExactlyOnceWith("run-1", "Authenticated ingestion requires admin action", new Date("2026-08-21T00:00:00.000Z"));
    expect(auditSink.record).toHaveBeenCalledWith(expect.objectContaining({ action: "scrape_run.needs_admin_action", metadata: { stage: "precollection_authentication", reason: "authenticated_ingestion_disabled", status: "needs_admin_action", bankId: "popular" } }));
    expect(adminAlerts.notifyIngestionAttention).toHaveBeenCalledWith({ runId: "run-1", bankId: "popular", status: "needs_admin_action", safeErrorSummary: "Authenticated ingestion requires admin action" });
    expect(JSON.stringify(auditSink.record.mock.calls)).not.toMatch(/enabled|owner|fingerprint|attempt/);
  });

  it.each([legacy(), { ...legacy(), expiredEventId: "expired-1" }])("completes legacy delivery terminally without high-level capabilities", async (data) => {
    const { processor, complete } = setup();
    await processor({ data });
    expect(complete).toHaveBeenCalledWith({ runId: "run-1", bankId: "popular", status: "needs_admin_action", reason: "legacy_authenticated_ingestion_delivery" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([
    { ...v1(), authentication: { version: 2, attemptId: "attempt-1" } },
    { ...v1(), ownerToken: "injected" },
    { ...v1(), extra: true },
    Object.defineProperty(v1(), "extra", { enumerable: false, value: true }),
    Object.assign(v1(), { [Symbol("hidden")]: true }),
    Object.assign(Object.create({ extra: true }), v1()),
    Object.assign([], v1()),
    null,
  ])("fails malformed or unknown delivery closed when a safe run id is available", async (data) => {
    const { processor, complete } = setup();
    if (data === null) return expect(processor({ data })).rejects.toEqual(new AuthenticatedIngestionInvalidJobError());
    await processor({ data });
    expect(complete).toHaveBeenCalledWith({ runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" });
  });

  it("does not invoke outer or nested getters and leaks no hostile value", async () => {
    let outerRead = false;
    let nestedRead = false;
    const nested = Object.defineProperty({ version: 1 }, "attemptId", { enumerable: true, get: () => { nestedRead = true; throw new Error("raw-nested-sentinel"); } });
    const { processor, complete } = setup();
    await processor({ data: { ...v1(), authentication: nested } });
    await expect(processor(Object.defineProperty({}, "data", { enumerable: true, get: () => { outerRead = true; throw new Error("raw-outer-sentinel"); } }) as { data: unknown })).rejects.toEqual(new AuthenticatedIngestionInvalidJobError());
    expect(nestedRead).toBe(false); expect(outerRead).toBe(false);
    expect(JSON.stringify(complete.mock.calls)).not.toMatch(/raw-(nested|outer)-sentinel/);
  });

  it.each([
    Object.defineProperty({ version: 1, attemptId: "attempt-1" }, "hidden", { value: true }),
    Object.assign({ version: 1, attemptId: "attempt-1" }, { [Symbol("hidden")]: true }),
    Object.assign(Object.create({ extra: true }), { version: 1, attemptId: "attempt-1" }),
    { version: 1, attemptId: "attempt-1", extra: true },
    null,
    [],
  ])("rejects nested hostile records without changing the terminal reason", async (authentication) => {
    const { processor, complete } = setup();
    await processor({ data: { ...v1(), authentication } });
    expect(complete).toHaveBeenCalledWith({ runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" });
  });

  it("rejects forged signals without leaks while native signals preserve disabled semantics", async () => {
    const controller = new AbortController();
    const { processor, complete } = setup();
    await processor({ data: v1(), signal: controller.signal });
    const forged = Object.create(AbortSignal.prototype);
    Object.defineProperty(forged, "aborted", { get: () => { throw new Error("raw-signal-sentinel"); } });
    await processor({ data: v1(), signal: forged } as never);
    await processor({ data: v1(), signal: new Proxy(controller.signal, { get() { throw new Error("raw-proxy-sentinel"); } }) } as never);
    expect(complete.mock.calls.map(([outcome]) => outcome)).toEqual([
      { runId: "run-1", bankId: "popular", status: "needs_admin_action", reason: "authenticated_ingestion_disabled" },
      { runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" },
      { runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" },
    ]);
    expect(JSON.stringify(complete.mock.calls)).not.toMatch(/raw-(signal|proxy)-sentinel/);
  });

  it("exposes only terminal completion at its dependency boundary and has no product wiring", async () => {
    const compatible: (job: { data: unknown; signal?: AbortSignal }) => Promise<{ status: string; inserted: number; skipped: number }> = createDisabledAuthenticatedIngestionProcessor({ complete: async () => ({ status: "failed", inserted: 0, skipped: 0 }) });
    // @ts-expect-error The disabled processor cannot receive a probe or other high-level capability.
    createDisabledAuthenticatedIngestionProcessor({ complete: async () => ({ status: "failed", inserted: 0, skipped: 0 }), probe: {} });
    expect(compatible).toBeTypeOf("function");
    const source = await readFile(new URL("./authenticated-ingestion-activation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/probe|precondition|credential|browser|collection|scraper|owner.?token|lock|process\.env|bullmq|prisma|ingestion-worker/i);
  });
});
