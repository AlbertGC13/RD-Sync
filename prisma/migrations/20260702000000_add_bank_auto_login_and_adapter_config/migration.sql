-- CreateTable
CREATE TABLE "BankAutoLoginConfig" (
    "id" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "autoLoginEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakerState" TEXT NOT NULL DEFAULT 'closed',
    "breakerFailureCount" INTEGER NOT NULL DEFAULT 0,
    "breakerFailureWindowStart" TIMESTAMP(3),
    "breakerOpenedAt" TIMESTAMP(3),
    "breakerLastResetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "BankAutoLoginConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAdapterConfig" (
    "id" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "scrapingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "BankAdapterConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankAutoLoginConfig_bankCode_key" ON "BankAutoLoginConfig"("bankCode");

-- CreateIndex
CREATE UNIQUE INDEX "BankAdapterConfig_bankCode_key" ON "BankAdapterConfig"("bankCode");

-- AddForeignKey
ALTER TABLE "BankAutoLoginConfig" ADD CONSTRAINT "BankAutoLoginConfig_bankCode_fkey" FOREIGN KEY ("bankCode") REFERENCES "Bank"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAdapterConfig" ADD CONSTRAINT "BankAdapterConfig_bankCode_fkey" FOREIGN KEY ("bankCode") REFERENCES "Bank"("code") ON DELETE CASCADE ON UPDATE CASCADE;
