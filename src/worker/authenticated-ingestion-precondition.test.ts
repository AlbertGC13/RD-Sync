import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createAuthenticatedIngestionPrecondition,
  type AuthenticatedIngestionPreconditionDependencies,
} from "./authenticated-ingestion-precondition";

const identity = { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" };
const env = { RD_SYNC_AUTHENTICATION_LEASE_MS: "60000", RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "15000" };

function createHarness(overrides: Partial<AuthenticatedIngestionPreconditionDependencies> = {}) {
  const coordinate = vi.fn(async () => ({ status: "authentication_required" as const, authority: Object.freeze(Object.create(null)) as never }));
  const execute = vi.fn(async () => ({ status: "succeeded" as const }));
  const run = vi.fn(async () => ({ status: "authenticated" as const }));
  const start = vi.fn(() => ({ stop: vi.fn(async () => undefined) }));
  const dependencies: AuthenticatedIngestionPreconditionDependencies = {
    env,
    coordinatorDependencies: { attempts: {} as never, probe: {} as never },
    runnerDependencies: {} as never,
    job: { data: { bankId: "popular", runId: "run-1", accountFingerprint: "account-fingerprint" } },
    createCoordinator: () => ({ coordinate }),
    createExecution: () => ({ execute }),
    createRunner: ({ execution }) => ({ run: async () => { await execution.execute({} as never); return run(); } }),
    createHeartbeat: () => ({ start }),
    ...overrides,
  };
  return { precondition: createAuthenticatedIngestionPrecondition(dependencies), coordinate, run, execute, start };
}

describe("createAuthenticatedIngestionPrecondition", () => {
  it("composes a valid unauthenticated attempt through fresh coordinator, runner, and fenced execution", async () => {
    const harness = createHarness();

    await expect(harness.precondition({ identity, ownerToken: "owner-token" })).resolves.toEqual({ status: "authenticated" });
    expect(harness.coordinate).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledOnce();
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it("bypasses execution infrastructure when the coordinator reports an authenticated session", async () => {
    const coordinator = vi.fn(async () => ({ status: "authenticated" as const, source: "existing" as const }));
    const harness = createHarness({ createCoordinator: () => ({ coordinate: coordinator }) });

    await expect(harness.precondition({ identity, ownerToken: "owner-token" })).resolves.toEqual({ status: "authenticated" });
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("creates fresh execution and runner state for each invocation", async () => {
    const createExecution = vi.fn(() => ({ execute: vi.fn(async () => ({ status: "succeeded" as const })) }));
    const createRunner = vi.fn(() => ({ run: vi.fn(async () => ({ status: "authenticated" as const })) }));
    const harness = createHarness({ createExecution, createRunner });

    await harness.precondition({ identity, ownerToken: "owner-token" });
    await harness.precondition({ identity, ownerToken: "owner-token" });
    expect(createExecution).toHaveBeenCalledTimes(2);
    expect(createRunner).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    [],
    { identity: { ...identity, bankCode: "" }, ownerToken: "owner-token" },
    { identity, ownerToken: "" },
    { identity, ownerToken: "owner-token", extra: true },
    { identity, ownerToken: "owner-token", expiredEventId: "legacy" },
    { identity: { ...identity, runId: "other-run" }, ownerToken: "owner-token" },
  ])("fails closed without constructing dangerous dependencies for malformed input %#", async (input) => {
    const harness = createHarness();

    await expect(harness.precondition(input)).resolves.toEqual({ status: "invalid_request" });
    expect(harness.coordinate).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("rejects accessor, inherited, and symbol descriptor attacks without reading getters", async () => {
    const getter = vi.fn(() => "owner-token");
    const accessor = Object.defineProperty({ identity }, "ownerToken", { enumerable: true, get: getter });
    const inherited = Object.create({ ownerToken: "owner-token" }) as { identity: typeof identity };
    inherited.identity = identity;
    const symbol = Object.assign({ identity, ownerToken: "owner-token" }, { [Symbol("secret")]: true });
    const harness = createHarness();

    for (const input of [accessor, inherited, symbol]) await expect(harness.precondition(input)).resolves.toEqual({ status: "invalid_request" });
    expect(getter).not.toHaveBeenCalled();
    expect(harness.coordinate).not.toHaveBeenCalled();
  });

  it("returns only safe vocabulary when dependencies throw sentinel secrets", async () => {
    const secret = "credential-secret owner-token https://bank.example";
    const harness = createHarness({ createCoordinator: () => ({ coordinate: async () => { throw new Error(secret); } }) });

    const result = await harness.precondition({ identity, ownerToken: "owner-token" });
    expect(result).toEqual({ status: "needs_operator_action", reason: "authentication_attempt_requires_review" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("cancels before coordinator, browser, credentials, or mutation work for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness();

    await expect(harness.precondition({ identity, ownerToken: "owner-token", signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    expect(harness.coordinate).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("fails invalid heartbeat configuration during construction before dependencies are created", () => {
    const createCoordinator = vi.fn();

    expect(() => createHarness({ env: { ...env, RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "60000" }, createCoordinator })).toThrow("Invalid authentication heartbeat configuration.");
    expect(createCoordinator).not.toHaveBeenCalled();
  });

  it("rejects legacy expiry job descriptors before any invocation can activate dependencies", () => {
    const createCoordinator = vi.fn();

    expect(() => createHarness({ job: { data: { bankId: "popular", runId: "run-1", accountFingerprint: "account-fingerprint", expiredEventId: "legacy" } }, createCoordinator })).toThrow("Invalid authenticated ingestion precondition configuration.");
    expect(createCoordinator).not.toHaveBeenCalled();
  });

  it("remains inert and uses attempt-only completion", () => {
    const source = readFileSync(new URL("./authenticated-ingestion-precondition.ts", import.meta.url), "utf8");

    expect(source).toContain('completion: { mode: "attempt_only" }');
    expect(source).not.toMatch(/BullMQ|Prisma|process\.env|setInterval/);
  });
});
