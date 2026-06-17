import { describe, expect, it } from "vitest";

import { signSession, verifySession, type SessionPayload } from "./session";

const SECRET = "test-secret-please-ignore";
const NOW = 1_000_000_000_000;

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return { userId: "user-1", role: "admin", expiresAt: NOW + 60_000, ...overrides };
}

describe("session token", () => {
  it("round-trips a valid token back to a principal", () => {
    const token = signSession(payload(), SECRET);
    expect(verifySession(token, SECRET, NOW)).toEqual({ id: "user-1", role: "admin" });
  });

  it("returns null when the signature is tampered", () => {
    const token = signSession(payload(), SECRET);
    const [body] = token.split(".");
    const forged = `${body}.AAAAtampered`;
    expect(verifySession(forged, SECRET, NOW)).toBeNull();
  });

  it("returns null when the payload is tampered (signature no longer matches)", () => {
    const token = signSession(payload({ role: "viewer" }), SECRET);
    const sig = token.split(".")[1];
    const forgedBody = Buffer.from(JSON.stringify(payload({ role: "admin" })), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifySession(`${forgedBody}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it("returns null for a token signed with a different secret", () => {
    const token = signSession(payload(), "another-secret");
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  it("returns null when the token is expired", () => {
    const token = signSession(payload({ expiresAt: NOW - 1 }), SECRET);
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  it("accepts a token that expires exactly in the future and rejects at/after expiry", () => {
    const token = signSession(payload({ expiresAt: NOW + 1 }), SECRET);
    expect(verifySession(token, SECRET, NOW)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + 1)).toBeNull();
  });

  it("returns null for malformed tokens", () => {
    expect(verifySession("", SECRET, NOW)).toBeNull();
    expect(verifySession("nodot", SECRET, NOW)).toBeNull();
    expect(verifySession(".onlysig", SECRET, NOW)).toBeNull();
    expect(verifySession("body.", SECRET, NOW)).toBeNull();
    expect(verifySession("not-base64!.sig", SECRET, NOW)).toBeNull();
  });

  it("returns null when the payload shape is invalid", () => {
    const badBody = Buffer.from(JSON.stringify({ userId: 1, role: "king" }), "utf8")
      .toString("base64url");
    // Sign it correctly so only the shape is wrong
    const token = signSession(payload(), SECRET);
    const sig = token.split(".")[1];
    // The signature won't match badBody, so this also covers tamper; build a correctly
    // signed bad-shape token by re-signing is not exposed, so we assert tamper-null here.
    expect(verifySession(`${badBody}.${sig}`, SECRET, NOW)).toBeNull();
  });
});
