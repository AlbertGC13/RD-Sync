import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("produces a stored value that is not the plaintext", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).not.toContain("correct horse battery staple");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(stored.split(":")).toHaveLength(3);
  });

  it("verifies a correct password", async () => {
    const stored = await hashPassword("s3cret-pass");
    expect(await verifyPassword("s3cret-pass", stored)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const stored = await hashPassword("s3cret-pass");
    expect(await verifyPassword("wrong-pass", stored)).toBe(false);
  });

  it("uses a random salt so the same password yields different stored values", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    expect(a).not.toBe(b);
    // Both still verify
    expect(await verifyPassword("same-input", a)).toBe(true);
    expect(await verifyPassword("same-input", b)).toBe(true);
  });

  it("returns false (never throws) on malformed stored values", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt:only-two")).toBe(false);
    expect(await verifyPassword("x", "bcrypt:aa:bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt::")).toBe(false);
    expect(await verifyPassword("x", "scrypt:zz:zz")).toBe(false);
  });
});
