BEGIN;

ALTER TABLE "ManualRecoveryResolution"
  ADD COLUMN "replayExpiredEventId" TEXT,
  ADD COLUMN "replayRunId" TEXT,
  ADD COLUMN "replayAuthorizedAt" TIMESTAMP(3),
  ADD CONSTRAINT "ManualRecoveryResolution_replayTuple_check" CHECK (
    ("replayExpiredEventId" IS NULL AND "replayRunId" IS NULL AND "replayAuthorizedAt" IS NULL)
    OR ("replayExpiredEventId" IS NOT NULL AND "replayRunId" IS NOT NULL AND "replayAuthorizedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "ManualRecoveryResolution_replayDecision_check" CHECK (
    "replayExpiredEventId" IS NULL
    OR ("outcome" = 'safe_to_retry' AND "reason" = 'verified_no_mutation')
  ),
  ADD CONSTRAINT "ManualRecoveryResolution_replayId_check" CHECK (
    "replayExpiredEventId" IS NULL OR (
      "replayExpiredEventId" ~ '[^[:space:]]'
      AND "replayRunId" ~ '[^[:space:]]'
      AND "replayExpiredEventId" <> "expiredEventId"
      AND "replayRunId" <> "runId"
    )
  );

CREATE UNIQUE INDEX "ManualRecoveryResolution_replayExpiredEventId_key"
  ON "ManualRecoveryResolution" ("replayExpiredEventId")
  WHERE "replayExpiredEventId" IS NOT NULL;
CREATE UNIQUE INDEX "ManualRecoveryResolution_replayRunId_key"
  ON "ManualRecoveryResolution" ("replayRunId")
  WHERE "replayRunId" IS NOT NULL;

COMMIT;
