export type LockBeforeDecryptOutcome<TResult> = Readonly<
  | { status: "completed"; result: TResult }
  | { status: "invalid_input" | "unsupported_bank" | "cancelled" | "lock_busy" | "lock_unavailable" | "credential_unavailable" | "execution_failed" }
>;

type Lease = Readonly<{ signal: AbortSignal; release(): Promise<boolean> }>;
type Request = Readonly<{ bankCode: string; signal?: AbortSignal }>;
type Dependencies<TCredential, TResult> = Readonly<{
  isSupportedBank(bankCode: string): boolean;
  lock: Readonly<{ acquire(input: Request): Promise<Lease | null> }>;
  loadCredential(bankCode: string): Promise<TCredential | null>;
  executeProtected(input: Readonly<{ bankCode: string; credential: TCredential; signal?: AbortSignal }>): Promise<TResult>;
  observeReleaseFailure?(): void;
}>;
const nativeAbortSignalAborted = typeof AbortSignal === "undefined" ? undefined : Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function outcome<TResult>(status: LockBeforeDecryptOutcome<TResult>["status"], result?: TResult): LockBeforeDecryptOutcome<TResult> {
  return Object.freeze(status === "completed" ? { status, result: result as TResult } : { status });
}

function parseRequest(value: unknown): Request | null {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Object.keys(descriptors); const bankCode = descriptors.bankCode; const signal = descriptors.signal;
    if (Object.getOwnPropertySymbols(value).length || !keys.includes("bankCode") || keys.some((key) => key !== "bankCode" && key !== "signal")) return null;
    if (!bankCode || !bankCode.enumerable || "get" in bankCode || "set" in bankCode || typeof bankCode.value !== "string" || !bankCode.value.trim()) return null;
    if (signal && (!signal.enumerable || "get" in signal || "set" in signal || signal.value === undefined || readNativeAbortState(signal.value) === null)) return null;
    return Object.freeze(signal ? { bankCode: bankCode.value, signal: signal.value } : { bankCode: bankCode.value });
  } catch { return null; }
}

function readNativeAbortState(value: unknown): boolean | null {
  try { return nativeAbortSignalAborted?.call(value) ?? null; } catch { return null; }
}

function parseLease(value: unknown): Lease | null {
  try {
    if (!value || typeof value !== "object" || !Object.isFrozen(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value); const signal = descriptors.signal; const release = descriptors.release;
    if (Object.keys(descriptors).length !== 2 || !signal || !release || "get" in signal || "set" in signal || "get" in release || "set" in release || typeof release.value !== "function" || readNativeAbortState(signal.value) === null) return null;
    return Object.freeze({ signal: signal.value as AbortSignal, release: release.value as () => Promise<boolean> });
  } catch { return null; }
}

function composeAbortSignals(external: AbortSignal | undefined, lease: AbortSignal) {
  const controller = new AbortController(); const abort = () => controller.abort();
  if (readNativeAbortState(external) || readNativeAbortState(lease)) abort();
  external?.addEventListener("abort", abort, { once: true }); lease.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, dispose: () => { external?.removeEventListener("abort", abort); lease.removeEventListener("abort", abort); } };
}

export function createLockBeforeDecryptCredentialCapability<TCredential, TResult>(dependencies: Dependencies<TCredential, TResult>) {
  return Object.freeze({
    async run(value: unknown): Promise<LockBeforeDecryptOutcome<TResult>> {
      const request = parseRequest(value);
      if (!request) return outcome("invalid_input");
      try { if (!dependencies.isSupportedBank(request.bankCode)) return outcome("unsupported_bank"); } catch { return outcome("unsupported_bank"); }
      if (readNativeAbortState(request.signal) === true) return outcome("cancelled");
      let lease: Lease | null;
      try { lease = await dependencies.lock.acquire(request); } catch { return outcome("lock_unavailable"); }
      if (!lease) return outcome("lock_busy");
      const parsedLease = parseLease(lease);
      if (!parsedLease) { try { await lease.release(); } catch {} return outcome("lock_unavailable"); }
      const composed = composeAbortSignals(request.signal, parsedLease.signal);
      try {
        if (readNativeAbortState(composed.signal) === true) return outcome("cancelled");
        let credential: TCredential | null;
        try { credential = await dependencies.loadCredential(request.bankCode); } catch { return outcome("credential_unavailable"); }
        if (readNativeAbortState(composed.signal) === true) return outcome("cancelled");
        if (credential == null) return outcome("credential_unavailable");
        try { return outcome("completed", await dependencies.executeProtected(Object.freeze({ bankCode: request.bankCode, credential, signal: composed.signal }))); } catch { return outcome("execution_failed"); }
      } finally {
        let releaseFailed = false;
        try { releaseFailed = !(await lease.release()); } catch { releaseFailed = true; }
        if (releaseFailed) try { dependencies.observeReleaseFailure?.(); } catch {}
        composed.dispose();
      }
    },
  });
}
