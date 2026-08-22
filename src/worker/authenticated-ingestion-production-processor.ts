import type { BankAutoLoginOutcome, BankAutoLoginStrategy, ScrapeTimeAutoLoginBrowserResult } from "./scraper/auto-login";
import { createAuditEvent } from "../modules/audit";
import { BANK_CREDENTIAL_ACTIONS } from "../modules/audit/bank-actions";
import { createAuthenticatedIngestionProcessor, type AuthenticatedIngestionProcessorDependencies } from "./authenticated-ingestion-composition";
import type { AuthenticationExecutionResult } from "./scraper/authenticated-session-mutation-runner";
import { createLockBeforeDecryptCredentialCapability } from "./scraper/lock-before-decrypt-credential-capability";
import { createProtectedAutoLoginExecution } from "./scraper/protected-auto-login-execution";
import { createStrictAutoLoginCredentialLoader } from "./scraper/strict-auto-login-credential-loader";
import type { AuthenticatedIngestionProductionResources } from "./authenticated-ingestion-production-resources";

type Adapter = Readonly<{ bankCode: string; createAutoLoginStrategy(): BankAutoLoginStrategy }>;
type BrowserDependencies = Readonly<{
  adapterRegistry: Readonly<{ get(bankCode: string): Adapter | undefined }>;
  cdpUrlForBankCode(bankCode: string): string | undefined;
  ensureBrowser(bankCode: string, cdpUrl: string): Promise<ScrapeTimeAutoLoginBrowserResult>;
}>;
export type AuthenticatedIngestionProductionProcessorDependencies = Readonly<
  BrowserDependencies & Omit<AuthenticatedIngestionProcessorDependencies, "attempts" | "runnerDependencies" | "executionFactory" | "restorationResolver" | "scrapeRuns" | "transactions" | "auditSink" | "adminAlerts">
>;

function mapOutcome(outcome: BankAutoLoginOutcome): AuthenticationExecutionResult {
  if (outcome.status === "succeeded") return { status: "succeeded" };
  if (outcome.reason === "protected_flow") return { status: "rejected", cause: "protected_or_mfa" };
  if (outcome.reason === "incompatible_flow") return { status: "rejected", cause: "incompatible_flow" };
  if (["auto_login_config_unavailable", "credential_unavailable", "portal_state_unavailable", "browser_unavailable", "auto_login_execution_failed"].includes(outcome.reason)) return { status: "transient_unavailable" };
  if (outcome.reason === "unknown_post_submit_state") return { status: "rejected", cause: "unknown" };
  return { status: "rejected", cause: "structural_configuration" };
}

export function createAuthenticatedIngestionProductionProcessor(
  resources: AuthenticatedIngestionProductionResources,
  dependencies: AuthenticatedIngestionProductionProcessorDependencies,
) {
  const credentials = createStrictAutoLoginCredentialLoader({
    findAuthenticationMaterialByBankCode: (bankCode) => resources.credentials.findAuthenticationMaterialByBankCode(bankCode),
    resolveKey: resources.credentialKeyResolver,
    recordDecryptUse: ({ bankCode, keyVersion }) => resources.auditSink.record(createAuditEvent({
      actorId: "system:auto-login", actorRole: null, action: BANK_CREDENTIAL_ACTIONS.DECRYPT_USE,
      target: "bank_credential", targetId: null, metadata: { bankCode, keyVersion },
    })),
  });
  return createAuthenticatedIngestionProcessor({
    ...dependencies,
    attempts: resources.authenticationAttempts,
    restorationResolver: resources.restorationResolver,
    scrapeRuns: resources.scrapeRuns,
    transactions: resources.transactions,
    auditSink: resources.auditSink,
    adminAlerts: resources.alertSink,
    executionFactory: ({ job, identity }) => ({
      async execute({ fence, signal }) {
        let adapter: Adapter | undefined;
        let unavailable: "transient" | "structural" = "transient";
        const capability = createLockBeforeDecryptCredentialCapability({
          isSupportedBank: (bankCode) => (adapter = dependencies.adapterRegistry.get(bankCode)) !== undefined,
          lock: resources.bankAuthenticationLock,
          loadCredential: async (bankCode) => {
            const config = await resources.autoLoginConfigs.getByBankCode(bankCode);
            if (!config || !config.autoLoginEnabled || config.breakerState !== "closed") { unavailable = "structural"; return null; }
            const loaded = await credentials.load(bankCode);
            if (loaded.status === "loaded") return loaded.credential;
            unavailable = loaded.status === "structural_unavailable" ? "structural" : "transient";
            return null;
          },
          executeProtected: async ({ bankCode, credential, signal: lockSignal }) => {
            const cdpUrl = dependencies.cdpUrlForBankCode(bankCode);
            if (cdpUrl === undefined || adapter === undefined) return { status: "structural_configuration" as const };
            return createProtectedAutoLoginExecution(Object.freeze({ job: Object.freeze({ bankCode, runId: job.runId, accountFingerprint: job.accountFingerprint }), identity, credential, fence, signal: lockSignal ?? signal, cdpUrl, adapter, ensureBrowser: dependencies.ensureBrowser })).execute();
          },
        });
        const result = await capability.run(Object.freeze({ bankCode: identity.bankCode, signal }));
        if (result.status === "completed") {
          if (result.result.status === "completed") return mapOutcome(result.result.outcome);
          if (result.result.status === "throttled" || result.result.status === "browser_unavailable") return { status: "transient_unavailable" };
          if (result.result.status === "structural_configuration") return { status: "rejected", cause: "structural_configuration" };
          return { status: "blocked" };
        }
        if (result.status === "cancelled") return { status: "cancelled" };
        if (result.status === "credential_unavailable") return (unavailable as "transient" | "structural") === "structural" ? { status: "rejected", cause: "structural_configuration" } : { status: "transient_unavailable" };
        if (result.status === "lock_busy" || result.status === "lock_unavailable") return { status: "transient_unavailable" };
        return { status: "blocked" };
      },
    }),
  });
}
