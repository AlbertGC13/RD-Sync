import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("produces a stored value that is not the plaintext", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).not.toContain("correct horse battery staple");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(stored.split(":")).toHaveLength(3);
  });

  it("verifies a correct password", () => {
    const stored = hashPassword("s3cret-pass");
    expect(verifyPassword("s3cret-pass", stored)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const stored = hashPassword("s3cret-pass");
    expect(verifyPassword("wrong-pass", stored)).toBe(false);
  });

  it("uses a random salt so the same password yields different stored values", () => {
    const a = hashPassword("same-input");
    const b = hashPassword("same-input");
    expect(a).not.toBe(b);
    // Both still verify
    expect(verifyPassword("same-input", a)).toBe(true);
    expect(verifyPassword("same-input", b)).toBe(true);
  });

  it("returns false (never throws) on malformed stored values", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt:only-two")).toBe(false);
    expect(verifyPassword("x", "bcrypt:aa:bb")).toBe(false);
    expect(verifyPassword("x", "scrypt::")).toBe(false);
    expect(verifyPassword("x", "scrypt:zz:zz")).toBe(false);
  });
});
