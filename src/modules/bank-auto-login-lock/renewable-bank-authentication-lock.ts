import { randomBytes } from "node:crypto";
import { buildBankAuthenticationLockKey, DEFAULT_LOCK_TTL_MS, MAX_LOCK_TTL_MS, type LockStore } from "./index";

export type RenewableBankAuthenticationLease = Readonly<{ signal: AbortSignal; release(): Promise<boolean> }>;
export type RenewableBankAuthenticationLock = Readonly<{ acquire(input: Readonly<{ bankCode: string; signal?: AbortSignal }>): Promise<RenewableBankAuthenticationLease | null> }>;
type Timer = { unref?(): void };
type Scheduler = Readonly<{ setInterval(callback: () => void, ms: number): Timer; clearInterval(timer: Timer): void }>;

const defaultScheduler: Scheduler = { setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>) };
const defaultGenerateLeaseToken = () => randomBytes(16).toString("hex");

export function createRenewableBankAuthenticationLock(options: Readonly<{ store: LockStore; ttlMs?: number; renewIntervalMs?: number; generateLeaseToken?: () => string; now?: () => number; scheduler?: Scheduler }>): RenewableBankAuthenticationLock {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? ttlMs / 3;
  if (!options.store || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LOCK_TTL_MS || !Number.isFinite(renewIntervalMs) || renewIntervalMs <= 0 || renewIntervalMs >= ttlMs) throw new Error("Invalid renewable lock timing");
  const { store, generateLeaseToken = defaultGenerateLeaseToken, now = () => Date.now(), scheduler = defaultScheduler } = options;
  return Object.freeze({ async acquire({ bankCode }) {
    const key = buildBankAuthenticationLockKey(bankCode); const token = generateLeaseToken();
    if (await store.acquireSlot({ key, leaseToken: token, ttlMs, nowMs: now() }) === null) return null;
    const controller = new AbortController(); const state: { stopped: boolean; timer?: Timer } = { stopped: false }; let chain = Promise.resolve(); let releasePromise: Promise<boolean> | undefined;
    const stop = () => { if (!state.stopped) { state.stopped = true; if (state.timer) scheduler.clearInterval(state.timer); } };
    const lose = () => { stop(); if (!controller.signal.aborted) controller.abort(); };
    const renew = () => { if (state.stopped) return; chain = chain.then(async () => { if (state.stopped) return; try { if (!await store.renewIfOwner({ key, expectedLeaseToken: token, newTtlMs: ttlMs, nowMs: now() })) lose(); } catch { lose(); } }); void chain.catch(() => undefined); };
    state.timer = scheduler.setInterval(renew, renewIntervalMs); if (state.stopped) scheduler.clearInterval(state.timer); else state.timer.unref?.();
    const release = (): Promise<boolean> => releasePromise ??= (stop(), chain.then(() => store.releaseIfOwner(key, token)));
    return Object.freeze({ signal: controller.signal, release });
  } });
}
