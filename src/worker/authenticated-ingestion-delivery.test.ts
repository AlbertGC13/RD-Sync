import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSessionPreconditionResult } from "../modules/bank-sessions/authenticated-session-precondition";
import type { IngestionResult } from "./queues";
import {
  AuthenticatedIngestionInvalidJobError,
  AuthenticatedIngestionRetryError,
  AuthenticatedIngestionTerminalError,
  createAuthenticatedIngestionDeliveryProcessor,
} from "./authenticated-ingestion-delivery";

const payload = () => ({ runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1", authentication: { version: 1, attemptId: "attempt-1" } });
const result = { status: "succeeded", inserted: 1, skipped: 0 };
const setup = (precondition: unknown = { status: "authenticated" }, terminalResult = { status: "needs_admin_action", inserted: 0, skipped: 0 }) => {
  const authenticate = vi.fn<(input: unknown) => Promise<AuthenticatedSessionPreconditionResult>>(async () => precondition as AuthenticatedSessionPreconditionResult);
  const downstream = vi.fn<(job: unknown) => Promise<unknown>>(async () => result);
  const complete = vi.fn<(outcome: unknown) => Promise<unknown>>(async () => terminalResult);
  const createOwnerToken = vi.fn(() => "owner-token");
  return { authenticate, downstream, complete, createOwnerToken, processor: createAuthenticatedIngestionDeliveryProcessor({ authenticate, downstream, complete, createOwnerToken }) };
};

describe("createAuthenticatedIngestionDeliveryProcessor", () => {
  it("passes the queued durable identity to authentication, strips its wrapper, and delegates once", async () => {
    const { processor, authenticate, downstream, complete } = setup();
    await expect(processor({ data: payload() })).resolves.toEqual(result);
    expect(authenticate).toHaveBeenCalledWith({ identity: { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" }, ownerToken: "owner-token" });
    expect(downstream).toHaveBeenCalledWith({ data: { runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1" } });
    expect(complete).not.toHaveBeenCalled();
  });

  it("creates a fresh owner token per delivery and never includes it in jobs or results", async () => {
    const { processor, authenticate, downstream, createOwnerToken } = setup();
    createOwnerToken.mockReturnValueOnce("owner-1").mockReturnValueOnce("owner-2");
    const first = await processor({ data: payload() }); const second = await processor({ data: payload() });
    expect(authenticate.mock.calls.map(([input]) => (input as { ownerToken: string }).ownerToken)).toEqual(["owner-1", "owner-2"]);
    expect(JSON.stringify({ first, second, retry: new AuthenticatedIngestionRetryError("retry_delivery") })).not.toMatch(/owner-|fingerprint-1|attempt-1|credential|url|raw-sentinel/);
    expect(downstream).toHaveBeenCalledTimes(2);
  });

  it.each([{ runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1" }, { runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1", expiredEventId: "expired-1" }])("completes legacy payloads safely", async (data) => {
    const { processor, authenticate, downstream, complete } = setup();
    await expect(processor({ data })).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(complete).toHaveBeenCalledWith({ runId: "run-1", status: "needs_admin_action", reason: "legacy_authenticated_ingestion_delivery" });
    expect(authenticate).not.toHaveBeenCalled(); expect(downstream).not.toHaveBeenCalled();
  });

  it.each([
    { ...payload(), authentication: { version: 2, attemptId: "attempt-1" } },
    { ...payload(), bankId: " " },
    Object.defineProperty(payload(), "bankId", { enumerable: true, get: () => { throw new Error("raw getter"); } }),
    Object.defineProperty(payload(), "extra", { enumerable: false, value: "hidden" }),
    Object.assign(payload(), { extra: "extra" }),
    Object.assign(payload(), { [Symbol("unexpected")]: true }),
    { runId: "run-1", bankId: "popular", authentication: { version: 1, attemptId: "attempt-1" } },
    Object.assign([], payload()),
  ])("fails closed for malformed payloads without invoking dangerous dependencies", async (data) => {
    const { processor, authenticate, downstream, complete } = setup();
    await expect(processor({ data })).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(authenticate).not.toHaveBeenCalled(); expect(downstream).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "invalid_authenticated_ingestion_delivery" }));
  });

  it("throws a fixed typed invalid-job error when no safe run id is available", async () => {
    const { processor, authenticate, downstream, complete } = setup();
    await expect(processor({ data: null })).rejects.toEqual(new AuthenticatedIngestionInvalidJobError());
    await expect(processor({ data: { bankId: "popular", accountFingerprint: "fingerprint-1", authentication: { version: 1, attemptId: "attempt-1" } } })).rejects.toEqual(new AuthenticatedIngestionInvalidJobError());
    await expect(processor({ data: Object.create({ runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1", authentication: { version: 1, attemptId: "attempt-1" } }) })).rejects.toEqual(new AuthenticatedIngestionInvalidJobError());
    await expect(processor({ data: { ...payload(), runId: " " } })).rejects.toEqual(new AuthenticatedIngestionInvalidJobError());
    expect(authenticate).not.toHaveBeenCalled(); expect(downstream).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });

  it.each(["retry_delivery", "in_progress", "cancelled"] as const)("throws a safe typed retry for %s", async (status) => {
    const { processor, downstream, complete } = setup({ status });
    await expect(processor({ data: payload() })).rejects.toEqual(new AuthenticatedIngestionRetryError(status));
    expect(downstream).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });

  it.each(["temporary_authentication_problem", "protected_authentication_step_detected", "bank_login_configuration_requires_review", "authentication_attempt_requires_review", "identity_conflict", "restoration_state_conflict"])("maps operator reason %s to a safe terminal outcome", async (reason) => {
    const { processor, downstream, complete } = setup({ status: "needs_operator_action", reason });
    await processor({ data: payload() });
    expect(complete).toHaveBeenCalledWith({ runId: "run-1", status: "needs_admin_action", reason });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("maps invalid and malformed or thrown preconditions to safe terminal outcomes without leaking", async () => {
    for (const precondition of [{ status: "invalid_request" }, { status: "unexpected", secret: "raw-sentinel" }]) {
      const { processor, downstream, complete } = setup(precondition);
      await processor({ data: payload() });
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/invalid|review/) })); expect(downstream).not.toHaveBeenCalled();
    }
    const { processor, downstream, complete } = setup();
    const throwing = createAuthenticatedIngestionDeliveryProcessor({ authenticate: async () => { throw new Error("raw-sentinel"); }, downstream, complete, createOwnerToken: () => "owner" });
    await throwing({ data: payload() }); expect(downstream).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledWith(expect.objectContaining({ reason: "authentication_precondition_requires_review" }));
    await expect(processor({ data: payload() })).resolves.toEqual(result);
  });

  it("returns downstream failed and session-expired results unchanged without recovery", async () => {
    for (const downstreamResult of [{ status: "failed", inserted: 0, skipped: 0 }, { status: "session_expired" }]) {
    const { processor, downstream, complete } = setup(); downstream.mockResolvedValueOnce(downstreamResult);
      await expect(processor({ data: payload() })).resolves.toEqual(downstreamResult);
      expect(downstream).toHaveBeenCalledTimes(1); expect(complete).not.toHaveBeenCalled();
    }
  });

  it("wraps terminal completion failures in a fixed non-retry error", async () => {
    const { processor } = setup({ status: "invalid_request" });
    const broken = createAuthenticatedIngestionDeliveryProcessor({ authenticate: async () => ({ status: "invalid_request" }), downstream: async () => result, complete: async () => { throw new Error("raw terminal"); }, createOwnerToken: () => "owner" });
    await expect(broken({ data: payload() })).rejects.toEqual(new AuthenticatedIngestionTerminalError());
    await expect(processor({ data: payload() })).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
  });

  it("is assignable to the existing factory processor shape", () => {
    const factoryCompatible: (job: { data: unknown }) => Promise<IngestionResult> = createAuthenticatedIngestionDeliveryProcessor<IngestionResult>({
      authenticate: async () => ({ status: "authenticated" }),
      downstream: async () => ({ status: "succeeded", inserted: 0, skipped: 0 }),
      complete: async () => ({ status: "failed", inserted: 0, skipped: 0 }),
      createOwnerToken: () => "owner",
    });
    expect(factoryCompatible).toBeTypeOf("function");
  });

  it("contains no infrastructure or recovery coupling", async () => {
    const source = await readFile(new URL("./authenticated-ingestion-delivery.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/bullmq|prisma|process\.env|recoverExpiredSession|ingestion-worker|from ["'][^"']*queues/i);
  });
});
