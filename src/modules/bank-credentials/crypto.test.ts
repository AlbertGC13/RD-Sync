import { describe, it, expect } from "vitest";
import {
  encryptCredentialField,
  decryptCredentialField,
  type AesGcmEnvelope,
} from "./crypto";

const TEST_KEY = Buffer.alloc(32, 0x42);
const testKeyResolver = (): Buffer => TEST_KEY;
const wrongKeyResolver = (): Buffer => Buffer.alloc(32, 0xff);

describe("AES-256-GCM credential envelope", () => {
  describe("round-trip", () => {
    it.each([
      "super-secret-password-123",
      "",
      "Contraseña de prueba ñ áéíóú 你好",
      "A".repeat(10_000),
    ])("decrypts encrypted plaintext %#", (plaintext) => {
      const recovered = decryptCredentialField(
        encryptCredentialField(plaintext, testKeyResolver),
        testKeyResolver,
      );
      expect(recovered).toBe(plaintext);
    });
  });

  describe("IV uniqueness", () => {
    it("produces different IVs across multiple encryptions of the same plaintext", () => {
      const ivs = new Set(
        Array.from({ length: 20 }, () =>
          encryptCredentialField("same-password", testKeyResolver).iv,
        ),
      );
      expect(ivs.size).toBe(20);
    });
  });

  describe("wrong key", () => {
    it("throws on decryption with a different key", () => {
      const envelope = encryptCredentialField("secret", testKeyResolver);
      expect(() => decryptCredentialField(envelope, wrongKeyResolver)).toThrow();
    });
  });

  describe("tampering", () => {
    it.each(["tag", "ciphertext"] as const)("throws when %s is modified", (field) => {
      const envelope = encryptCredentialField("secret", testKeyResolver);
      const tampered: AesGcmEnvelope = {
        ...envelope,
        [field]: flipFirstByte(envelope[field]),
      };
      expect(() => decryptCredentialField(tampered, testKeyResolver)).toThrow();
    });
  });

  describe("unknown keyVersion", () => {
    it("throws when the envelope keyVersion is not supported by the resolver", () => {
      const envelope = {
        ...encryptCredentialField("secret", testKeyResolver, 1),
        keyVersion: 99,
      };

      expect(() =>
        decryptCredentialField(envelope, (v) => {
          if (v === 1) return TEST_KEY;
          throw new Error(`unknown key version: ${v}`);
        }),
      ).toThrow();
    });
  });

  describe("malformed envelope", () => {
    it.each([
      ["iv", "!!!not-base64!!!"],
      ["ciphertext", "not!base64"],
      ["tag", "not!base64"],
      ["iv", Buffer.alloc(4, 0xaa).toString("base64")],
    ] as const)("throws on malformed %s", (field, value) => {
      const envelope = encryptCredentialField("secret", testKeyResolver);
      const tampered: AesGcmEnvelope = { ...envelope, [field]: value };
      expect(() => decryptCredentialField(tampered, testKeyResolver)).toThrow();
    });

    it.each(["iv", "ciphertext", "tag"] as const)(
      "throws when otherwise valid %s base64 has appended invalid characters",
      (field) => {
        const envelope = encryptCredentialField("secret", testKeyResolver);
        const tampered: AesGcmEnvelope = {
          ...envelope,
          [field]: `${envelope[field]}!`,
        };

        expect(() => decryptCredentialField(tampered, testKeyResolver)).toThrow(
          /invalid base64/,
        );
      },
    );
  });

  describe("no plaintext leakage", () => {
    it("ciphertext does not contain the plaintext bytes", () => {
      const plaintext = "my-super-secret-password";
      const envelope = encryptCredentialField(plaintext, testKeyResolver);
      expect(Buffer.from(envelope.ciphertext, "base64").toString("hex")).not.toContain(
        Buffer.from(plaintext, "utf-8").toString("hex"),
      );
    });
  });

  describe("keyVersion", () => {
    it("defaults to version 1 and preserves explicit versions", () => {
      expect(encryptCredentialField("secret", testKeyResolver).keyVersion).toBe(1);

      const explicit = encryptCredentialField("secret", testKeyResolver, 5);
      expect(explicit.keyVersion).toBe(5);
      expect(decryptCredentialField(explicit, testKeyResolver)).toBe("secret");
    });
  });

  describe("envelope shape", () => {
    it("stores base64 fields with expected iv/tag lengths", () => {
      const envelope = encryptCredentialField("test", testKeyResolver);
      expect(typeof envelope.keyVersion).toBe("number");
      expect(typeof envelope.iv).toBe("string");
      expect(typeof envelope.ciphertext).toBe("string");
      expect(typeof envelope.tag).toBe("string");
      expect(() => Buffer.from(envelope.iv, "base64")).not.toThrow();
      expect(() => Buffer.from(envelope.ciphertext, "base64")).not.toThrow();
      expect(() => Buffer.from(envelope.tag, "base64")).not.toThrow();
      expect(Buffer.from(envelope.iv, "base64").length).toBe(12);
      expect(Buffer.from(envelope.tag, "base64").length).toBe(16);
    });
  });
});

function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return b64;
  buf[0] ^= 0x01;
  return buf.toString("base64");
}
