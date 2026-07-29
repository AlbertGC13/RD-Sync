-- CreateTable
CREATE TABLE "BankCredential" (
    "id" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "encryptedUsernameEnvelope" TEXT NOT NULL,
    "encryptedPasswordEnvelope" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankCredential_bankCode_key" ON "BankCredential"("bankCode");

-- AddForeignKey
ALTER TABLE "BankCredential" ADD CONSTRAINT "BankCredential_bankCode_fkey" FOREIGN KEY ("bankCode") REFERENCES "Bank"("code") ON DELETE CASCADE ON UPDATE CASCADE;
