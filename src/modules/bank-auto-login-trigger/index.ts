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

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value).sort();
  return ownKeys.length === keys.length
    && ownKeys.every((key, index) => key === keys[index])
    && !Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function validateNonblankId(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new AutoLoginTriggerValidationError(`${field} must be a nonblank string up to ${MAX_ID_LENGTH} characters`);
  }
}

export function parseAutoLoginTriggerIdentity(value: unknown): AutoLoginTriggerIdentity {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["id", "kind"])) {
    throw new AutoLoginTriggerValidationError("must be a plain object with exactly kind and id");
  }
  validateNonblankId("id", value.id);
  if (value.kind === "session_expiry" && SESSION_EXPIRY_ID_RE.test(value.id)) return { kind: value.kind, id: value.id };
  if (value.kind === "authentication_attempt" && AUTHENTICATION_ATTEMPT_ID_RE.test(value.id)) return { kind: value.kind, id: value.id };
  throw new AutoLoginTriggerValidationError("kind or id is not recognized");
}

export function createAuthenticationAttemptTrigger(identity: SessionAuthenticationAttemptIdentity): AutoLoginTriggerIdentity {
  if (!isPlainRecord(identity) || !hasExactKeys(identity, ["attemptId", "bankCode", "runId"])) {
    throw new AutoLoginTriggerValidationError("authentication attempt must have exactly bankCode, runId, and attemptId");
  }
  validateNonblankId("bankCode", identity.bankCode);
  validateNonblankId("runId", identity.runId);
  validateNonblankId("attemptId", identity.attemptId);
  return {
    kind: "authentication_attempt",
    id: createHash("sha256").update(JSON.stringify([identity.runId, identity.attemptId])).digest("hex"),
  };
}
