import { createHash } from "node:crypto";

import type { SessionAuthenticationAttemptIdentity } from "../bank-sessions/session-authentication-attempt";

export type AutoLoginTriggerIdentity = Readonly<
  | { kind: "session_expiry"; id: string }
  | { kind: "authentication_attempt"; id: string }
>;

export class AutoLoginTriggerValidationError extends Error {
  constructor(message: string) {
    super(`Invalid auto-login trigger: ${message}`);
    this.name = "AutoLoginTriggerValidationError";
  }
}

const SESSION_EXPIRY_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const AUTHENTICATION_ATTEMPT_ID_RE = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 256;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function readExactDataProperties(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function validateNonblankId(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new AutoLoginTriggerValidationError(`${field} must be a nonblank string up to ${MAX_ID_LENGTH} characters`);
  }
}

export function parseAutoLoginTriggerIdentity(value: unknown): AutoLoginTriggerIdentity {
  const trigger = readExactDataProperties(value, ["id", "kind"]);
  if (!trigger) {
    throw new AutoLoginTriggerValidationError("must be a plain object with exactly kind and id");
  }
  validateNonblankId("id", trigger.id);
  if (trigger.kind === "session_expiry" && SESSION_EXPIRY_ID_RE.test(trigger.id)) return { kind: trigger.kind, id: trigger.id };
  if (trigger.kind === "authentication_attempt" && AUTHENTICATION_ATTEMPT_ID_RE.test(trigger.id)) return { kind: trigger.kind, id: trigger.id };
  throw new AutoLoginTriggerValidationError("kind or id is not recognized");
}

export function createAuthenticationAttemptTrigger(identity: SessionAuthenticationAttemptIdentity): AutoLoginTriggerIdentity {
  const attemptIdentity = readExactDataProperties(identity, ["attemptId", "bankCode", "runId"]);
  if (!attemptIdentity) {
    throw new AutoLoginTriggerValidationError("authentication attempt must have exactly bankCode, runId, and attemptId");
  }
  validateNonblankId("bankCode", attemptIdentity.bankCode);
  validateNonblankId("runId", attemptIdentity.runId);
  validateNonblankId("attemptId", attemptIdentity.attemptId);
  return {
    kind: "authentication_attempt",
    id: createHash("sha256").update(JSON.stringify([attemptIdentity.runId, attemptIdentity.attemptId])).digest("hex"),
  };
}
