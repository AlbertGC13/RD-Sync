/**
 * AutoLoginLock with fencing tokens. Prevents concurrent scrape runs from
 * double-submitting credentials for the SAME expired session event.
 * Scoped to bankCode + expiredEventId.
 */
import { randomBytes } from "node:crypto";

export interface AcquiredLock {
  leaseToken: string;
  fencingToken: number;
  expiresAt: number;
}

export interface AutoLoginLock {
  acquire(bankCode: string, expiredEventId: string, ttlMs?: number): Promise<AcquiredLock | null>;
  release(bankCode: string, expiredEventId: string, leaseToken: string): Promise<boolean>;
  renew(bankCode: string, expiredEventId: string, leaseToken: string, ttlMs?: number): Promise<boolean>;
}

/** Store abstraction for distributed locking. Production wraps ioredis via atomic Lua scripts. */
export interface LockStore {
  acquireSlot(key: string, leaseToken: string, ttlMs: number, nowMs: number): Promise<number | null>;
  releaseIfOwner(key: string, expectedLeaseToken: string): Promise<boolean>;
  renewIfOwner(key: string, expectedLeaseToken: string, newTtlMs: number, nowMs: number): Promise<boolean>;
}



export interface CreateAutoLoginLockOptions {
  store: LockStore;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  generateLeaseToken?: () => string;
  now?: () => number;
}

export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
export const MAX_LOCK_TTL_MS = 15 * 60 * 1000;
export const LOCK_KEY_PREFIX = "autologin:lock";

export class LockValidationError extends Error {
  constructor(field: string, message: string) {
    super(`Invalid ${field}: ${message}`);
    this.name = "LockValidationError";
  }
}

const BANK_CODE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const EVENT_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

function validate(field: string, value: unknown, tests: [boolean, string][]): void {
  for (const [ok, msg] of tests) {
    if (!ok) throw new LockValidationError(field, msg);
  }
}

function validateBankCode(bankCode: string): void {
  validate("bankCode", bankCode, [
    [typeof bankCode === "string" && bankCode.length > 0, "must be a non-empty string"],
    [BANK_CODE_RE.test(bankCode), "must be 1-32 chars, lowercase alphanumeric/underscore/hyphen, starting with a letter"],
  ]);
}

function validateEventId(eventId: string): void {
  validate("expiredEventId", eventId, [
    [typeof eventId === "string" && eventId.length > 0, "must be a non-empty string"],
    [eventId.length <= 64, "must be at most 64 characters"],
    [EVENT_ID_RE.test(eventId), "must contain only alphanumeric characters and hyphens"],
  ]);
}

function validateLeaseToken(leaseToken: string): void {
  validate("leaseToken", leaseToken, [
    [typeof leaseToken === "string" && leaseToken.length > 0, "must be a non-empty string"],
  ]);
}

function validateTtlMs(ttlMs: number, maxTtlMs?: number): void {
  validate("ttlMs", ttlMs, [
    [typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0, "must be a positive number"],
    ...(maxTtlMs != null ? [[ttlMs <= maxTtlMs, `must not exceed ${maxTtlMs}ms`] as [boolean, string]] : []),
  ]);
}

export function buildLockKey(bankCode: string, expiredEventId: string): string {
  return `${LOCK_KEY_PREFIX}:${bankCode}:${expiredEventId}`;
}
function defaultGenerateLeaseToken(): string {
  return randomBytes(16).toString("hex");
}

export function createAutoLoginLock(options: CreateAutoLoginLockOptions): AutoLoginLock {
  const { store, defaultTtlMs = DEFAULT_LOCK_TTL_MS, maxTtlMs = MAX_LOCK_TTL_MS, generateLeaseToken = defaultGenerateLeaseToken, now = () => Date.now() } = options;

  if (!store) throw new Error("LockStore is required");

  return {
    async acquire(bankCode, expiredEventId, ttlMs?) {
      validateBankCode(bankCode);
      validateEventId(expiredEventId);
      const effectiveTtlMs = ttlMs ?? defaultTtlMs;
      validateTtlMs(effectiveTtlMs, maxTtlMs);
      const key = buildLockKey(bankCode, expiredEventId);
      const leaseToken = generateLeaseToken();
      const currentTime = now();
      const fencingToken = await store.acquireSlot(key, leaseToken, effectiveTtlMs, currentTime);
      if (fencingToken === null) return null;
      return { leaseToken, fencingToken, expiresAt: currentTime + effectiveTtlMs };
    },
    async release(bankCode, expiredEventId, leaseToken) {
      validateBankCode(bankCode);
      validateEventId(expiredEventId);
      validateLeaseToken(leaseToken);
      return store.releaseIfOwner(buildLockKey(bankCode, expiredEventId), leaseToken);
    },
    async renew(bankCode, expiredEventId, leaseToken, ttlMs?) {
      validateBankCode(bankCode);
      validateEventId(expiredEventId);
      validateLeaseToken(leaseToken);
      const effectiveTtlMs = ttlMs ?? defaultTtlMs;
      validateTtlMs(effectiveTtlMs, maxTtlMs);
      return store.renewIfOwner(buildLockKey(bankCode, expiredEventId), leaseToken, effectiveTtlMs, now());
    },
  };
}
