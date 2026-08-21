import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { prismaPg, prismaClient } = vi.hoisted(() => ({ prismaPg: vi.fn(), prismaClient: vi.fn() }));

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: prismaPg }));
vi.mock("../../generated/prisma/client", () => ({ PrismaClient: prismaClient }));

import { BankCredentialRepository } from "../bank-credentials/repository";
import { createCredentialKeyResolver } from "../bank-credentials/key-resolver";
import { PrismaAuditSink } from "./prisma-audit-sink";
import { createPrismaClient } from "./prisma-client";
import { PrismaScrapeRunRepository } from "./prisma-scrape-run-repository";
import { PrismaTransactionRepository } from "./prisma-transaction-repository";

afterEach(() => vi.clearAllMocks());

describe("authenticated ingestion data seams", () => {
  it("builds an explicit Prisma client from the supplied URL without connecting", () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://ignored.example/test";
    const client = { $connect: vi.fn() };
    prismaClient.mockImplementation(function () { return client; });

    expect(createPrismaClient("postgres://user:pass@db.example:5432/rd_sync")).toBe(client);
    expect(prismaPg).toHaveBeenCalledWith({ connectionString: "postgres://user:pass@db.example:5432/rd_sync" });
    expect(client.$connect).not.toHaveBeenCalled();
    process.env.DATABASE_URL = previous;
  });

  it("keeps injected Prisma clients instead of resolving the default", async () => {
    const client = {
      bank: { upsert: vi.fn().mockResolvedValue({ id: "bank-1" }) },
      scrapeRun: { findMany: vi.fn().mockResolvedValue([]) },
      transaction: { findMany: vi.fn().mockResolvedValue([]) },
      auditEvent: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await expect(new PrismaScrapeRunRepository(client as never).list({})).resolves.toEqual([]);
    await expect(new PrismaTransactionRepository(client as never).list({})).resolves.toEqual([]);
    await expect(new PrismaAuditSink(client as never).list()).resolves.toEqual([]);
    expect(prismaClient).not.toHaveBeenCalled();
  });

  it("projects and freezes only authentication material", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      bankCode: "popular", isActive: true, keyVersion: 1,
      encryptedUsernameEnvelope: "username", encryptedPasswordEnvelope: "password",
    });
    const repository = new BankCredentialRepository({ bankCredential: { findUnique } } as never);

    const result = await repository.findAuthenticationMaterialByBankCode("popular");
    expect(findUnique).toHaveBeenCalledWith({ where: { bankCode: "popular" }, select: {
      bankCode: true, isActive: true, keyVersion: true,
      encryptedUsernameEnvelope: true, encryptedPasswordEnvelope: true,
    } });
    expect(result).toEqual({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: "username", encryptedPasswordEnvelope: "password" });
    expect(Object.isFrozen(result)).toBe(true);
    await expect(repository.findAuthenticationMaterialByBankCode("bad code")).rejects.toThrow("Invalid bank code");
    expect(findUnique).toHaveBeenCalledTimes(1);
    findUnique.mockResolvedValueOnce(null);
    await expect(repository.findAuthenticationMaterialByBankCode("popular")).resolves.toBeNull();
    findUnique.mockRejectedValueOnce(new Error("query unavailable"));
    await expect(repository.findAuthenticationMaterialByBankCode("popular")).rejects.toThrow("query unavailable");
  });

  it("returns fresh version-one key copies without reading environment after construction", () => {
    const source = readFileSync(new URL("../bank-credentials/key-resolver.ts", import.meta.url), "utf8");
    const factory = source.slice(source.indexOf("export function createCredentialKeyResolver"), source.indexOf("export function resolveCredentialKey"));
    expect(factory.slice(0, factory.indexOf("return (version"))).not.toMatch(/decodeKey\(|Buffer\.from|process\.env/);
    const resolver = createCredentialKeyResolver("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const first = resolver(1);
    first.fill(0);
    expect(resolver(1).toString("hex")).toBe("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    expect(createCredentialKeyResolver(Buffer.alloc(32, 7).toString("base64"))(1)).toHaveLength(32);
    expect(() => resolver(2)).toThrow("Unsupported key version");
    expect(() => createCredentialKeyResolver("not-a-key")).toThrow("not valid base64 or hex");
    expect(() => createCredentialKeyResolver("AA==")).toThrow("decoded to 1 bytes");
    const canonical = Buffer.alloc(32).toString("base64");
    expect(() => createCredentialKeyResolver(`${canonical.slice(0, -2)}B=`)).toThrow("not valid base64 or hex");
  });
});
