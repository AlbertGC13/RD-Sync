import type { AuthenticatedSessionProbe } from "../../modules/bank-sessions/ensure-authenticated-session";

export interface ReadonlySessionChecker {
  check(): Promise<unknown>;
}
type CheckerResult = Readonly<{ status: "active" | "expired" | "browser_unavailable"; checkedAt: string; safeSummary: string }>;

export type AuthenticatedSessionProbeDependencies = Readonly<{ popularSessionChecker: ReadonlySessionChecker }>;

const unavailable = (): Awaited<ReturnType<AuthenticatedSessionProbe["observe"]>> => ({ status: "unavailable" });

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function parseResult(value: unknown): CheckerResult | null {
  const record = exact(value, ["status", "checkedAt", "safeSummary"]);
  return record && (record.status === "active" || record.status === "expired" || record.status === "browser_unavailable") && typeof record.checkedAt === "string" && typeof record.safeSummary === "string"
    ? record as CheckerResult
    : null;
}

function observedAt(value: string): Date | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? new Date(timestamp) : null;
}

function isAborted(signal: AbortSignal | undefined): boolean | null {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return null;
  }
}

/** Maps a read-only, already-attached CDP checker to the coordinator probe port.
 * The checker owns its timeout and page closure; cancellation only suppresses its result. */
export function createAuthenticatedSessionProbe(
  { popularSessionChecker }: AuthenticatedSessionProbeDependencies,
): AuthenticatedSessionProbe {
  return {
    async observe(input) {
      try {
        if (input.bankCode !== "popular" || isAborted(input.signal) !== false) return unavailable();
        const result = parseResult(await popularSessionChecker.check());
        if (isAborted(input.signal) !== false || !result) return unavailable();
        if (result.status === "expired") return { status: "unauthenticated" };
        if (result.status !== "active") return unavailable();
        const timestamp = observedAt(result.checkedAt);
        return timestamp ? { status: "authenticated", observedAt: timestamp } : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
