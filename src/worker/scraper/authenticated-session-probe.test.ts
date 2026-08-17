import { describe, expect, it } from "vitest";

import type { AuthenticatedSessionProbe } from "../../modules/bank-sessions/ensure-authenticated-session";
import { createAuthenticatedSessionProbe, type ReadonlySessionChecker } from "./authenticated-session-probe";

const checkedAt = "2026-08-16T12:00:00.000Z";
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;
const checkerHasOnlyReadCapability: Equal<keyof ReadonlySessionChecker, "check"> = true;

function checker(result: unknown) {
  let calls = 0;
  return {
    checker: { check: async () => { calls += 1; return result; } },
    calls: () => calls,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe("createAuthenticatedSessionProbe", () => {
  it("requires only the read-only checker capability", () => {
    expect(checkerHasOnlyReadCapability).toBe(true);
  });

  it("maps one valid active Popular check to a cloned authenticated observation", async () => {
    const source = { status: "active", checkedAt, safeSummary: "Bank session is active" };
    const fake = checker(source);
    const probe: AuthenticatedSessionProbe = createAuthenticatedSessionProbe({ popularSessionChecker: fake.checker });

    const result = await probe.observe({ bankCode: "popular" });

    expect(result).toEqual({ status: "authenticated", observedAt: new Date(checkedAt) });
    expect(result.status === "authenticated" && result.observedAt).not.toBe(source.checkedAt);
    expect(fake.calls()).toBe(1);
  });

  it("maps expired and browser_unavailable checks without exposing checker data", async () => {
    const expired = await createAuthenticatedSessionProbe({ popularSessionChecker: checker({ status: "expired", checkedAt, safeSummary: "x" }).checker }).observe({ bankCode: "popular" });
    const unavailable = await createAuthenticatedSessionProbe({ popularSessionChecker: checker({ status: "browser_unavailable", checkedAt, safeSummary: "x" }).checker }).observe({ bankCode: "popular" });

    expect(expired).toEqual({ status: "unauthenticated" });
    expect(unavailable).toEqual({ status: "unavailable" });
  });

  it("does not call the checker for unknown or mismatched banks", async () => {
    const fake = checker({ status: "active", checkedAt, safeSummary: "x" });
    const probe = createAuthenticatedSessionProbe({ popularSessionChecker: fake.checker });

    await expect(probe.observe({ bankCode: "bhd" })).resolves.toEqual({ status: "unavailable" });
    await expect(probe.observe({ bankCode: "Popular" })).resolves.toEqual({ status: "unavailable" });
    expect(fake.calls()).toBe(0);
  });

  it("does not call a checker for a pre-aborted signal", async () => {
    const fake = checker({ status: "active", checkedAt, safeSummary: "x" });
    const controller = new AbortController();
    controller.abort();

    await expect(createAuthenticatedSessionProbe({ popularSessionChecker: fake.checker }).observe({ bankCode: "popular", signal: controller.signal })).resolves.toEqual({ status: "unavailable" });
    expect(fake.calls()).toBe(0);
  });

  it("never returns authenticated when cancelled during a deferred check", async () => {
    const pending = deferred<unknown>();
    let calls = 0;
    const controller = new AbortController();
    const probe = createAuthenticatedSessionProbe({ popularSessionChecker: { check: async () => { calls += 1; return pending.promise; } } });
    const observation = probe.observe({ bankCode: "popular", signal: controller.signal });

    controller.abort();
    pending.resolve({ status: "active", checkedAt, safeSummary: "x" });

    await expect(observation).resolves.toEqual({ status: "unavailable" });
    expect(calls).toBe(1);
  });

  it("fails closed for hostile signals, thrown checkers, and malformed checker results", async () => {
    const sentinel = new Error("sentinel");
    const hostileSignal = { get aborted(): boolean { throw sentinel; } } as AbortSignal;
    const malformed = [null, [], { status: "other", checkedAt, safeSummary: "x" }, { status: "active", checkedAt: new Date("invalid"), safeSummary: "x" }, { status: "active", checkedAt: Number.POSITIVE_INFINITY, safeSummary: "x" }, { status: "active", checkedAt: "invalid", safeSummary: "x" }, { status: "active", checkedAt, safeSummary: "x", extra: true }];

    await expect(createAuthenticatedSessionProbe({ popularSessionChecker: checker({ status: "active", checkedAt, safeSummary: "x" }).checker }).observe({ bankCode: "popular", signal: hostileSignal })).resolves.toEqual({ status: "unavailable" });
    await expect(createAuthenticatedSessionProbe({ popularSessionChecker: { check: async () => { throw sentinel; } } }).observe({ bankCode: "popular" })).resolves.toEqual({ status: "unavailable" });
    for (const result of malformed) await expect(createAuthenticatedSessionProbe({ popularSessionChecker: checker(result).checker }).observe({ bankCode: "popular" })).resolves.toEqual({ status: "unavailable" });
  });

  it("does not invoke accessors or accept symbols or hidden fields", async () => {
    const accessor = Object.defineProperty({}, "status", { enumerable: true, get: () => { throw new Error("sentinel"); } });
    const symbol = { status: "active", checkedAt, safeSummary: "x", [Symbol("hidden")]: true };
    const hidden = Object.defineProperty({ status: "active", checkedAt, safeSummary: "x" }, "hidden", { value: true });

    for (const result of [accessor, symbol, hidden]) await expect(createAuthenticatedSessionProbe({ popularSessionChecker: checker(result).checker }).observe({ bankCode: "popular" })).resolves.toEqual({ status: "unavailable" });
  });
});
