BEGIN;

CREATE TABLE "BankSessionAuthenticationAttempt" (
  "bankCode" TEXT NOT NULL, "runId" TEXT NOT NULL, "attemptId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "interactionPhase" TEXT NOT NULL DEFAULT 'no_credential_interaction',
  "failureClass" TEXT, "operatorReason" TEXT, "retryCount" INTEGER NOT NULL DEFAULT 0,
  "ownerToken" TEXT, "generation" BIGINT NOT NULL DEFAULT 0, "leaseExpiresAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankSessionAuthenticationAttempt_pkey" PRIMARY KEY ("bankCode", "runId", "attemptId"),
  CONSTRAINT "BankSessionAuthenticationAttempt_bankCode_runId_key" UNIQUE ("bankCode", "runId"),
  CONSTRAINT "BankSessionAuthenticationAttempt_bankCode_fkey" FOREIGN KEY ("bankCode") REFERENCES "Bank"("code") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BankSessionAuthenticationAttempt_identity_check" CHECK ("bankCode" ~ '[^[:space:]]' AND "runId" ~ '[^[:space:]]' AND "attemptId" ~ '[^[:space:]]'),
  CONSTRAINT "BankSessionAuthenticationAttempt_status_check" CHECK ("status" IN ('active', 'authenticated', 'failed')),
  CONSTRAINT "BankSessionAuthenticationAttempt_phase_check" CHECK ("interactionPhase" IN ('no_credential_interaction', 'credentials_may_have_reached_portal', 'submit_may_have_been_dispatched')),
  CONSTRAINT "BankSessionAuthenticationAttempt_retry_check" CHECK ("retryCount" BETWEEN 0 AND 2),
  CONSTRAINT "BankSessionAuthenticationAttempt_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "BankSessionAuthenticationAttempt_owner_check" CHECK (("status" = 'active' AND (("ownerToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("ownerToken" ~ '[^[:space:]]' AND "leaseExpiresAt" IS NOT NULL))) OR ("status" <> 'active' AND "ownerToken" IS NULL AND "leaseExpiresAt" IS NULL)),
  CONSTRAINT "BankSessionAuthenticationAttempt_terminal_check" CHECK (("status" = 'active' AND "failureClass" IS NULL AND "operatorReason" IS NULL AND "terminalAt" IS NULL) OR ("status" = 'authenticated' AND "failureClass" IS NULL AND "operatorReason" IS NULL AND "terminalAt" IS NOT NULL) OR ("status" = 'failed' AND (("failureClass" = 'transient_pre_interaction' AND "operatorReason" = 'temporary_authentication_problem') OR ("failureClass" = 'protected_or_mfa' AND "operatorReason" = 'protected_authentication_step_detected') OR ("failureClass" IN ('incompatible_flow', 'structural_configuration') AND "operatorReason" = 'bank_login_configuration_requires_review') OR ("failureClass" IN ('ownership_lost', 'interaction_outcome_uncertain', 'unclassified_failure') AND "operatorReason" = 'authentication_attempt_requires_review')) AND "terminalAt" IS NOT NULL))
);

CREATE INDEX "BankSessionAuthenticationAttempt_status_leaseExpiresAt_idx" ON "BankSessionAuthenticationAttempt"("status", "leaseExpiresAt");

COMMIT;
