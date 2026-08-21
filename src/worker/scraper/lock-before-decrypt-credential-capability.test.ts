import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLockBeforeDecryptCredentialCapability } from "./lock-before-decrypt-credential-capability";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; return { promise: new Promise((done) => { resolve = done; }), resolve }; }
function input(bankCode = "popular", signal?: AbortSignal) { return Object.freeze(signal ? { bankCode, signal } : { bankCode }); }
function dependencies(events: string[], overrides: Partial<Parameters<typeof createLockBeforeDecryptCredentialCapability<{ secret: string }, string>>[0]> = {}) {
  const release = vi.fn(async () => { events.push("release"); return true; });
  const signal = new AbortController().signal;
  return {
    release,
    capability: createLockBeforeDecryptCredentialCapability<{ secret: string }, string>({
      isSupportedBank: (bankCode) => bankCode === "popular" || bankCode === "banreservas",
      lock: { acquire: async ({ bankCode }) => { events.push(`acquire:${bankCode}`); return Object.freeze({ signal, release }); } },
      loadCredential: async (bankCode) => { events.push(`load:${bankCode}`); return { secret: "credential-secret" }; },
      executeProtected: async ({ bankCode, credential }) => { events.push(`execute:${bankCode}:${credential.secret}`); return "ok"; },
      ...overrides,
    }),
  };
}

describe("createLockBeforeDecryptCredentialCapability", () => {
  it("fails closed for malformed, mutable, accessor, symbol, blank, and forged-signal input without dependencies", async () => {
    const events: string[] = []; const { capability } = dependencies(events); const forged = Object.freeze({ aborted: false }) as unknown as AbortSignal;
    const accessor = Object.freeze(Object.defineProperty({ bankCode: "popular" }, "signal", { enumerable: true, get: () => { throw new Error("must not read"); } }));
    for (const value of [null, Object.freeze({}), Object.freeze({ bankCode: "" }), Object.freeze({ bankCode: " ", extra: true }), { bankCode: "popular" }, accessor, Object.freeze({ bankCode: "popular", signal: forged }), Object.freeze({ bankCode: "popular", [Symbol("x")]: true })]) {
      await expect(capability.run(value as never)).resolves.toEqual({ status: "invalid_input" });
    }
    expect(events).toEqual([]);
  });

  it("fails closed for forged native prototypes, reflection traps, hidden fields, and undefined signals", async () => {
    const events: string[] = []; const { capability } = dependencies(events); const controller = new AbortController();
    const hiddenBankCode = Object.freeze(Object.defineProperty({}, "bankCode", { value: "popular" }));
    const hiddenSignal = Object.freeze(Object.defineProperty({ bankCode: "popular" }, "signal", { value: controller.signal }));
    const throwing = new Proxy({}, { getPrototypeOf: () => { throw new Error("trap"); } }); const revoked = Proxy.revocable(Object.freeze({ bankCode: "popular" }), {}); revoked.revoke();
    for (const value of [Object.freeze({ bankCode: "popular", signal: Object.create(AbortSignal.prototype) }), throwing, revoked.proxy, hiddenBankCode, hiddenSignal, Object.freeze({ bankCode: "popular", signal: undefined })]) {
      await expect(capability.run(value)).resolves.toEqual({ status: "invalid_input" });
    }
    expect(events).toEqual([]);
  });

  it("rejects unsupported or pre-aborted banks before lock acquisition", async () => {
    const events: string[] = []; const { capability } = dependencies(events); const controller = new AbortController(); controller.abort();
    await expect(capability.run(input("other"))).resolves.toEqual({ status: "unsupported_bank" });
    await expect(capability.run(input("popular", controller.signal))).resolves.toEqual({ status: "cancelled" });
    expect(events).toEqual([]);
  });

  it("accepts genuine native signals and safely observes their cancellation", async () => {
    const events: string[] = []; const { capability } = dependencies(events); const active = new AbortController(); const cancelled = new AbortController(); cancelled.abort();
    await expect(capability.run(input("popular", active.signal))).resolves.toEqual({ status: "completed", result: "ok" });
    await expect(capability.run(input("popular", cancelled.signal))).resolves.toEqual({ status: "cancelled" });
    expect(events).toEqual(["acquire:popular", "load:popular", "execute:popular:credential-secret", "release"]);
  });

  it("maps busy or unavailable locks safely without secret work", async () => {
    for (const acquired of [async () => null, async () => { throw new Error("redis-token://secret"); }]) {
      const events: string[] = []; const { capability, release } = dependencies(events, { lock: { acquire: acquired } });
      await expect(capability.run(input())).resolves.toEqual({ status: acquired.toString().includes("throw") ? "lock_unavailable" : "lock_busy" });
      expect([events, release]).toEqual([[], expect.any(Function)]);
      expect(release).not.toHaveBeenCalled();
    }
  });

  it("releases a lease arriving after cancellation without loading or executing", async () => {
    const events: string[] = []; const waiting = deferred<{ signal: AbortSignal; release(): Promise<boolean> } | null>(); const controller = new AbortController(); const leaseSignal = new AbortController().signal;
    const { capability, release } = dependencies(events, { lock: { acquire: async () => { events.push("acquire"); return waiting.promise; } } });
    const running = capability.run(input("popular", controller.signal)); controller.abort(); waiting.resolve(Object.freeze({ signal: leaseSignal, release }));
    await expect(running).resolves.toEqual({ status: "cancelled" }); expect(events).toEqual(["acquire", "release"]);
  });

  it("cancels after acquire or load before protected execution", async () => {
    for (const phase of ["acquire", "load"] as const) {
      const events: string[] = []; const controller = new AbortController(); const { capability } = dependencies(events, {
        lock: { acquire: async () => { events.push("acquire"); if (phase === "acquire") controller.abort(); return Object.freeze({ signal: new AbortController().signal, release: async () => { events.push("release"); return true; } }); } },
        loadCredential: async () => { events.push("load"); if (phase === "load") controller.abort(); return { secret: "credential-secret" }; },
      });
      await expect(capability.run(input("popular", controller.signal))).resolves.toEqual({ status: "cancelled" });
      expect(events).toEqual(phase === "acquire" ? ["acquire", "release"] : ["acquire", "load", "release"]);
    }
  });

  it("acquires, loads, executes, and releases in exact order", async () => {
    const events: string[] = []; const { capability } = dependencies(events);
    await expect(capability.run(input())).resolves.toEqual({ status: "completed", result: "ok" });
    expect(events).toEqual(["acquire:popular", "load:popular", "execute:popular:credential-secret", "release"]);
  });

  it("contains loader and execution failures while releasing exactly once", async () => {
    for (const [loadCredential, executeProtected, status] of [[async () => null, undefined, "credential_unavailable"], [async () => undefined as unknown as { secret: string }, undefined, "credential_unavailable"], [async () => { throw new Error("password"); }, undefined, "credential_unavailable"], [undefined, async () => { throw new Error("https://bank/secret"); }, "execution_failed"]] as const) {
      const events: string[] = []; const { capability, release } = dependencies(events, { ...(loadCredential && { loadCredential }), ...(executeProtected && { executeProtected }) });
      await expect(capability.run(input())).resolves.toEqual({ status }); expect(release).toHaveBeenCalledTimes(1); expect(events).not.toContain(expect.stringMatching(/^execute/) as never);
    }
  });

  it("preserves completed and failed outcomes when release fails and swallows an observer failure", async () => {
    for (const [releaseResult, executeProtected, expected] of [[false, undefined, { status: "completed", result: "ok" }], ["throw", async () => { throw new Error("secret"); }, { status: "execution_failed" }]] as const) {
      const events: string[] = []; const observeReleaseFailure = vi.fn(() => { throw new Error("observer-secret"); });
      const release = async () => { events.push("release"); if (releaseResult === "throw") throw new Error("token"); return false; };
      const { capability } = dependencies(events, { lock: { acquire: async () => Object.freeze({ signal: new AbortController().signal, release }) }, observeReleaseFailure, ...(executeProtected && { executeProtected }) });
      await expect(capability.run(input())).resolves.toEqual(expected); expect(observeReleaseFailure).toHaveBeenCalledTimes(1);
    }
  });

  it("freezes inputs and outcomes, isolates imports, and never leaks thrown diagnostics", async () => {
    const events: string[] = []; const secret = { password: "password", token: "lock-token", url: "https://bank.example" }; const { capability } = dependencies(events, { executeProtected: async () => { throw secret; } });
    const request = input(); const outcome = await capability.run(request);
    expect([Object.isFrozen(request), Object.isFrozen(outcome), JSON.stringify(outcome)]).toEqual([true, true, '{"status":"execution_failed"}']);
    const source = readFileSync(new URL("./lock-before-decrypt-credential-capability.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import /m); expect(source).not.toContain("export async function");
  });

  it("serializes same-bank work while allowing another bank and exposes no trigger identity", async () => {
    const held = new Set<string>(); const events: string[] = []; const capability = createLockBeforeDecryptCredentialCapability<{ secret: string }, string>({
      isSupportedBank: () => true, lock: { acquire: async ({ bankCode }) => { events.push(`acquire:${bankCode}`); if (held.has(bankCode)) return null; held.add(bankCode); return Object.freeze({ signal: new AbortController().signal, release: async () => { held.delete(bankCode); return true; } }); } },
      loadCredential: async (bankCode) => { events.push(`load:${bankCode}`); return { secret: bankCode }; }, executeProtected: async ({ bankCode }) => { events.push(`execute:${bankCode}`); return bankCode; },
    });
    await expect(Promise.all([capability.run(input("popular")), capability.run(input("popular")), capability.run(input("banreservas"))])).resolves.toEqual([{ status: "completed", result: "popular" }, { status: "lock_busy" }, { status: "completed", result: "banreservas" }]);
    expect(events).toEqual(["acquire:popular", "acquire:popular", "acquire:banreservas", "load:popular", "load:banreservas", "execute:popular", "execute:banreservas"]);
  });
  it("fails closed for a malformed lease after best-effort release", async () => {
    const events: string[] = []; const release = vi.fn(async () => true); const { capability } = dependencies(events, { lock: { acquire: async () => ({ signal: {} as AbortSignal, release }) } });
    await expect(capability.run(input())).resolves.toEqual({ status: "lock_unavailable" }); expect([release.mock.calls.length, events]).toEqual([1, []]);
  });
  it("composes lease loss with external cancellation before load and during execution", async () => {
    for (const phase of ["load", "execute"] as const) {
      const events: string[] = []; const loss = new AbortController(); const external = new AbortController(); let received: AbortSignal | undefined;
      const { capability } = dependencies(events, { lock: { acquire: async () => Object.freeze({ signal: loss.signal, release: async () => { events.push("release"); return true; } }) }, loadCredential: async () => { events.push("load"); if (phase === "load") loss.abort(); return { secret: "credential-secret" }; }, executeProtected: async ({ signal }) => { received = signal; events.push("execute"); if (phase === "execute") loss.abort(); return "ok"; } });
      await capability.run(input("popular", external.signal)); expect([phase === "load" ? events : received?.aborted, events.filter((event) => event === "release").length]).toEqual([phase === "load" ? ["load", "release"] : true, 1]);
      external.abort(); expect(received?.aborted ?? true).toBe(true);
    }
  });
});
