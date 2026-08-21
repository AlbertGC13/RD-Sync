export type LockBeforeDecryptOutcome<TResult> = Readonly<
  | { status: "completed"; result: TResult }
  | { status: "invalid_input" | "unsupported_bank" | "cancelled" | "lock_busy" | "lock_unavailable" | "credential_unavailable" | "execution_failed" }
>;

type Lease = Readonly<{ release(): Promise<boolean> }>;
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
      try {
        if (readNativeAbortState(request.signal) === true) return outcome("cancelled");
        let credential: TCredential | null;
        try { credential = await dependencies.loadCredential(request.bankCode); } catch { return outcome("credential_unavailable"); }
        if (credential == null || readNativeAbortState(request.signal) === true) return outcome(credential == null ? "credential_unavailable" : "cancelled");
        try { return outcome("completed", await dependencies.executeProtected(Object.freeze({ bankCode: request.bankCode, credential, ...(request.signal && { signal: request.signal }) }))); } catch { return outcome("execution_failed"); }
      } finally {
        let releaseFailed = false;
        try { releaseFailed = !(await lease.release()); } catch { releaseFailed = true; }
        if (releaseFailed) try { dependencies.observeReleaseFailure?.(); } catch {}
      }
    },
  });
}
