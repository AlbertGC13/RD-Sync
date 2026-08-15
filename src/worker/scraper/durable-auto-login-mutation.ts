import type { CredentialInteractionPhase } from "../../modules/bank-sessions/session-authentication-attempt";
import type {
  SessionAuthenticationAttemptRepository,
  SessionAuthenticationLeaseOwner,
} from "../../modules/bank-sessions/session-authentication-attempt-repository";
import type {
  BankAutoLoginCredential,
  BankAutoLoginOutcome,
  BankAutoLoginPage,
  BankAutoLoginStrategy,
} from "./auto-login";

type DurableAttempts = Pick<SessionAuthenticationAttemptRepository, "beginCredentialInteraction" | "renewLease" | "recordSubmitBarrier">;
type DurableBlockReason = "ownership_lost" | "durable_state_changed" | "persistence_unavailable";

export type DurableAutoLoginMutationResult =
  | Readonly<{ status: "completed"; outcome: BankAutoLoginOutcome; interactionPhase: CredentialInteractionPhase }>
  | Readonly<{ status: "blocked"; reason: DurableBlockReason; interactionPhase: CredentialInteractionPhase }>;

export async function executeDurablyFencedAutoLogin(input: Readonly<{
  strategy: BankAutoLoginStrategy;
  credential: BankAutoLoginCredential;
  page: BankAutoLoginPage;
  attempts: DurableAttempts;
  owner: SessionAuthenticationLeaseOwner;
  leaseDurationMs: number;
}>): Promise<DurableAutoLoginMutationResult> {
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
    throw new Error("Lease duration must be a positive safe integer");
  }

  let phase: CredentialInteractionPhase = "no_credential_interaction";
  let denial: DurableBlockReason | undefined;
  let clickFailed = false;

  const blockFor = (status: string): DurableBlockReason =>
    status === "stale_owner" || status === "lease_expired" ? "ownership_lost" : "durable_state_changed";
  const deny = (reason: DurableBlockReason): never => {
    denial ??= reason;
    throw new Error("Durable auto-login mutation denied");
  };

  const page: BankAutoLoginPage = {
    currentUrl: () => input.page.currentUrl(),
    hasVisibleSelector: (selector, timeoutMs) => input.page.hasVisibleSelector(selector, timeoutMs),
    protectedStateDetectionWindowMs: input.page.protectedStateDetectionWindowMs,
    async fill(selector, value) {
      if (!value) return input.page.fill(selector, value);
      if (denial) throw new Error("Durable auto-login mutation denied");
      try {
        const result = phase === "no_credential_interaction"
          ? await input.attempts.beginCredentialInteraction({ owner: input.owner, leaseDurationMs: input.leaseDurationMs })
          : await input.attempts.renewLease({ owner: input.owner, leaseDurationMs: input.leaseDurationMs });
        const authorized = phase === "no_credential_interaction" ? result.status === "interaction_started" : result.status === "lease_renewed";
        if (!authorized) deny(blockFor(result.status));
        if (phase === "no_credential_interaction") phase = "credentials_may_have_reached_portal";
      } catch {
        if (denial) throw new Error("Durable auto-login mutation denied");
        deny("persistence_unavailable");
      }
      return input.page.fill(selector, value);
    },
    async click(selector) {
      if (denial) throw new Error("Durable auto-login mutation denied");
      try {
        const result = await input.attempts.recordSubmitBarrier({ owner: input.owner, leaseDurationMs: input.leaseDurationMs });
        if (result.status !== "recorded") deny(blockFor(result.status));
        phase = "submit_may_have_been_dispatched";
      } catch {
        if (denial) throw new Error("Durable auto-login mutation denied");
        deny("persistence_unavailable");
      }
      try {
        return await input.page.click(selector);
      } catch (error) {
        clickFailed = true;
        throw error;
      }
    },
  };

  const outcome = await input.strategy.autoLogin({ credential: input.credential, page });
  if (denial) return { status: "blocked", reason: denial, interactionPhase: phase };
  if (clickFailed) return { status: "blocked", reason: "durable_state_changed", interactionPhase: phase };
  return { status: "completed", outcome, interactionPhase: phase };
}
