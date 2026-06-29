import type { BankCredential, PrismaClient } from "../../generated/prisma/client";

export type BankCredentialRecord = BankCredential;

export interface UpsertCredentialInput {
  bankCode: string;
  encryptedUsernameEnvelope: string;
  encryptedPasswordEnvelope: string;
  keyVersion: number;
}

export interface BankCredentialMetadata {
  bankCode: string;
  isActive: boolean;
  keyVersion: number;
  lastRotatedAt: Date | null;
}

export class BankCredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByBankCode(bankCode: string): Promise<BankCredentialRecord | null> {
    return this.prisma.bankCredential.findUnique({ where: { bankCode } });
  }

  async upsert(input: UpsertCredentialInput): Promise<BankCredentialRecord> {
    const now = new Date();
    return this.prisma.bankCredential.upsert({
      where: { bankCode: input.bankCode },
      create: {
        bankCode: input.bankCode,
        encryptedUsernameEnvelope: input.encryptedUsernameEnvelope,
        encryptedPasswordEnvelope: input.encryptedPasswordEnvelope,
        keyVersion: input.keyVersion,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        encryptedUsernameEnvelope: input.encryptedUsernameEnvelope,
        encryptedPasswordEnvelope: input.encryptedPasswordEnvelope,
        keyVersion: input.keyVersion,
        isActive: true,
        lastRotatedAt: now,
        updatedAt: now,
      },
    });
  }

  async getMetadata(bankCode: string): Promise<BankCredentialMetadata | null> {
    return this.prisma.bankCredential.findUnique({
      where: { bankCode },
      select: { bankCode: true, isActive: true, keyVersion: true, lastRotatedAt: true },
    });
  }
}
