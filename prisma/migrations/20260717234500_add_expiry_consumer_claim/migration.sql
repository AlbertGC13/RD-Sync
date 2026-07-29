ALTER TABLE "BankSessionExpiryEpisode"
  ADD COLUMN "consumerClaimToken" TEXT,
  ADD CONSTRAINT "BankSessionExpiryEpisode_consumerClaimToken_check" CHECK (
    "consumerClaimToken" IS NULL OR "consumerClaimToken" ~ '[^[:space:]]'
  );
