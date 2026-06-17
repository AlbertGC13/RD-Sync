-- AlterTable: add nullable passwordHash column to User
-- This column was added in schema.prisma (PR9) but was absent from the initial migration.
-- Existing rows receive NULL, which is valid — the column is declared optional (String?).
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
