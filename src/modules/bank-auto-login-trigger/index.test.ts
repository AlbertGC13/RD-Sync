import { describe, expect, it } from "vitest";
import {
  AutoLoginTriggerValidationError,
  createAuthenticationAttemptTrigger,
  parseAutoLoginTriggerIdentity,
} from "./index";

describe("auto-login trigger identity", () => {
  it("parses exact session-expiry and authentication-attempt variants", () => {
    expect(parseAutoLoginTriggerIdentity({ kind: "session_expiry", id: "evt-001" }))
      .toEqual({ kind: "session_expiry", id: "evt-001" });
    expect(parseAutoLoginTriggerIdentity({ kind: "authentication_attempt", id: "a".repeat(64) }))
      .toEqual({ kind: "authentication_attempt", id: "a".repeat(64) });
    const nullPrototype = Object.assign(Object.create(null), { kind: "session_expiry", id: "evt-001" });
    expect(parseAutoLoginTriggerIdentity(nullPrototype)).toEqual({ kind: "session_expiry", id: "evt-001" });
  });

  it.each([
    null, [], new Date(), "evt-001", 1, undefined,
    {}, { kind: "session_expiry" }, { id: "evt-001" },
    { kind: "unknown", id: "evt-001" }, { kind: "session_expiry", id: "evt-001", owner: "secret" },
    { kind: "session_expiry", id: "" }, { kind: "session_expiry", id: "   " },
    { kind: "session_expiry", id: "a".repeat(257) },
  ])("rejects malformed trigger %#", (input) => {
    expect(() => parseAutoLoginTriggerIdentity(input)).toThrow(AutoLoginTriggerValidationError);
  });

  it.each(["with spaces", "evt_001", "evt!", "a".repeat(65)])("rejects invalid session-expiry ids", (id) => {
    expect(() => parseAutoLoginTriggerIdentity({ kind: "session_expiry", id })).toThrow(AutoLoginTriggerValidationError);
  });

  it.each(["A".repeat(64), "a".repeat(63), "g".repeat(64), " ".repeat(64)])("rejects non-canonical authentication ids", (id) => {
    expect(() => parseAutoLoginTriggerIdentity({ kind: "authentication_attempt", id })).toThrow(AutoLoginTriggerValidationError);
  });

  it("creates a stable opaque digest from run and attempt without embedding the bank", () => {
    const first = createAuthenticationAttemptTrigger({ bankCode: "popular", runId: "run-1", attemptId: "attempt-1" });
    expect(first).toEqual(createAuthenticationAttemptTrigger({ bankCode: "popular", runId: "run-1", attemptId: "attempt-1" }));
    expect(first).not.toEqual(createAuthenticationAttemptTrigger({ bankCode: "popular", runId: "run-2", attemptId: "attempt-1" }));
    expect(first).not.toEqual(createAuthenticationAttemptTrigger({ bankCode: "popular", runId: "run-1", attemptId: "attempt-2" }));
    expect(first).toEqual({ kind: "authentication_attempt", id: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(first)).not.toContain("popular");
    expect(JSON.stringify(first)).not.toContain("run-1");
    expect(JSON.stringify(first)).not.toContain("attempt-1");
  });

  it.each([
    {}, { bankCode: "popular", runId: "run-1" },
    { bankCode: " ", runId: "run-1", attemptId: "attempt-1" },
    { bankCode: "popular", runId: "", attemptId: "attempt-1" },
    { bankCode: "popular", runId: "run-1", attemptId: "", generation: 1 },
  ])("rejects malformed authentication attempt identities %#", (identity) => {
    expect(() => createAuthenticationAttemptTrigger(identity as never)).toThrow(AutoLoginTriggerValidationError);
  });
});
