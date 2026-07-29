ALTER TABLE "BankSessionExpiryEpisode"
  ADD COLUMN "publicationState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "publicationClaimToken" TEXT, ADD COLUMN "publicationFailureReportedAt" TIMESTAMP(3),
  ADD CONSTRAINT "BankSessionExpiryEpisode_publicationState_check" CHECK (
    ("publicationState" IN ('pending', 'cancelled') AND "publicationClaimToken" IS NULL AND "publicationFailureReportedAt" IS NULL)
    OR ("publicationState" = 'publishing' AND "publicationClaimToken" IS NOT NULL AND "publicationClaimToken" ~ '[^[:space:]]')
    OR ("publicationState" = 'published' AND "publicationClaimToken" IS NOT NULL AND "publicationClaimToken" ~ '[^[:space:]]' AND "publicationFailureReportedAt" IS NULL));
