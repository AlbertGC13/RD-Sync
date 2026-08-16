import { randomBytes } from "node:crypto";

import { parseAutoLoginTriggerIdentity, type AutoLoginTriggerIdentity } from "../bank-auto-login-trigger";

export interface AcquiredLock {
  leaseToken: string;
  fencingToken: number;
  expiresAt: number;
}

export interface AutoLoginLock {
  acquire(bankCode: string, trigger: string | AutoLoginTriggerIdentity, ttlMs?: number): Promise<AcquiredLock | null>;
  release(bankCode: string, trigger: string | AutoLoginTriggerIdentity, leaseToken: string): Promise<boolean>;
  renew(bankCode: string, trigger: string | AutoLoginTriggerIdentity, leaseToken: string, ttlMs?: number): Promise<boolean>;
}

export interface AcquireSlotParams {
  key: string;
  leaseToken: string;
  ttlMs: number;
  nowMs: number;
}
export interface RenewIfOwnerParams {
  key: string;
  expectedLeaseToken: string;
  newTtlMs: number;
  nowMs: number;
}
export interface LockStore {
  acquireSlot(params: AcquireSlotParams): Promise<number | null>;
  releaseIfOwner(key: string, expectedLeaseToken: string): Promise<boolean>;
  renewIfOwner(params: RenewIfOwnerParams): Promise<boolean>;
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

function validate(field: string, tests: [boolean, string][]): void {
  for (const [ok, msg] of tests) {
    if (!ok) throw new LockValidationError(field, msg);
  }
}

function validateBankCode(bankCode: string): void {
  validate("bankCode", [
    [typeof bankCode === "string" && bankCode.length > 0, "must be a non-empty string"],
    [BANK_CODE_RE.test(bankCode), "must be 1-32 chars, lowercase alphanumeric/underscore/hyphen, starting with a letter"],
  ]);
}

function validateEventId(eventId: string): void {
  validate("expiredEventId", [
    [typeof eventId === "string" && eventId.length > 0, "must be a non-empty string"],
    [eventId.length <= 64, "must be at most 64 characters"],
    [EVENT_ID_RE.test(eventId), "must contain only alphanumeric characters and hyphens"],
  ]);
}

function validateLeaseToken(leaseToken: string): void {
  validate("leaseToken", [
    [typeof leaseToken === "string" && leaseToken.length > 0, "must be a non-empty string"],
  ]);
}

function validateTtlMs(ttlMs: number, maxTtlMs?: number): void {
  validate("ttlMs", [
    [typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0, "must be a positive number"],
    ...(maxTtlMs != null ? [[ttlMs <= maxTtlMs, `must not exceed ${maxTtlMs}ms`] as [boolean, string]] : []),
  ]);
}

export const buildLockKey = (bankCode: string, trigger: string | AutoLoginTriggerIdentity): string => {
  if (typeof trigger === "string") return `${LOCK_KEY_PREFIX}:${bankCode}:${trigger}`;
  return trigger.kind === "session_expiry"
    ? `${LOCK_KEY_PREFIX}:${bankCode}:${trigger.id}`
    : `${LOCK_KEY_PREFIX}:v2:${bankCode}:authentication_attempt:${trigger.id}`;
};

function validateTrigger(trigger: string | AutoLoginTriggerIdentity): string | AutoLoginTriggerIdentity {
  if (typeof trigger === "string") {
    validateEventId(trigger);
    return trigger;
  }
  try {
    return parseAutoLoginTriggerIdentity(trigger);
  } catch {
    throw new LockValidationError("trigger", "must be a valid auto-login trigger identity");
  }
}

const defaultGenerateLeaseToken = (): string => randomBytes(16).toString("hex");
export function createAutoLoginLock(options: {
  store: LockStore;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  generateLeaseToken?: () => string;
  now?: () => number;
}): AutoLoginLock {
  const { store, defaultTtlMs = DEFAULT_LOCK_TTL_MS, maxTtlMs = MAX_LOCK_TTL_MS, generateLeaseToken = defaultGenerateLeaseToken, now = () => Date.now() } = options;

  if (!store) throw new Error("LockStore is required");

  return {
    async acquire(bankCode, trigger, ttlMs?) {
      validateBankCode(bankCode);
      const validatedTrigger = validateTrigger(trigger);
      const effectiveTtlMs = ttlMs ?? defaultTtlMs;
      validateTtlMs(effectiveTtlMs, maxTtlMs);
      const key = buildLockKey(bankCode, validatedTrigger);
      const leaseToken = generateLeaseToken();
      const currentTime = now();
      const fencingToken = await store.acquireSlot({ key, leaseToken, ttlMs: effectiveTtlMs, nowMs: currentTime });
      if (fencingToken === null) return null;
      return { leaseToken, fencingToken, expiresAt: currentTime + effectiveTtlMs };
    },
    async release(bankCode, trigger, leaseToken) {
      validateBankCode(bankCode);
      const validatedTrigger = validateTrigger(trigger);
      validateLeaseToken(leaseToken);
      return store.releaseIfOwner(buildLockKey(bankCode, validatedTrigger), leaseToken);
    },
    async renew(bankCode, trigger, leaseToken, ttlMs?) {
      validateBankCode(bankCode);
      const validatedTrigger = validateTrigger(trigger);
      validateLeaseToken(leaseToken);
      const effectiveTtlMs = ttlMs ?? defaultTtlMs;
      validateTtlMs(effectiveTtlMs, maxTtlMs);
      return store.renewIfOwner({ key: buildLockKey(bankCode, validatedTrigger), expectedLeaseToken: leaseToken, newTtlMs: effectiveTtlMs, nowMs: now() });
    },
  };
}
