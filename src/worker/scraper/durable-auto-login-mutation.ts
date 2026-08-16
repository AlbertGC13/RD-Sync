import type {
  BankAutoLoginCredential,
  BankAutoLoginOutcome,
  BankAutoLoginPage,
  BankAutoLoginStrategy,
} from "./auto-login";
import type { CredentialMutationFence } from "./authenticated-session-mutation-runner";

export type DurableAutoLoginMutationResult =
  | Readonly<{ status: "completed"; outcome: BankAutoLoginOutcome }>
  | Readonly<{ status: "blocked" }>;

const authorized = (value: unknown) => typeof value === "object" && value !== null
  && Reflect.ownKeys(value).length === 1
  && Reflect.ownKeys(value)[0] === "status"
  && (value as Record<PropertyKey, unknown>).status === "authorized";

export async function executeDurablyFencedAutoLogin(input: Readonly<{
  strategy: BankAutoLoginStrategy;
  credential: BankAutoLoginCredential;
  page: BankAutoLoginPage;
  fence: CredentialMutationFence;
  signal: AbortSignal;
}>): Promise<DurableAutoLoginMutationResult> {
  let started = false;
  let blocked = input.signal.aborted;
  const fail = () => { blocked = true; };
  const denied = () => { throw new Error("Credential mutation blocked"); };
  const fence = async (operation: () => Promise<unknown>) => {
    if (blocked || input.signal.aborted) { fail(); denied(); }
    try { if (!authorized(await operation())) { fail(); denied(); } }
    catch { fail(); denied(); }
  };
  const raw = (operation: () => void | Promise<void>) => {
    if (input.signal.aborted) { fail(); denied(); }
    try { return operation(); } catch { fail(); denied(); }
  };
  const page: BankAutoLoginPage = {
    currentUrl: () => input.page.currentUrl(),
    hasVisibleSelector: (selector, timeoutMs) => input.page.hasVisibleSelector(selector, timeoutMs),
    protectedStateDetectionWindowMs: input.page.protectedStateDetectionWindowMs,
    async fill(selector, value) {
      if (!value) {
        try { await input.page.fill(selector, value); } catch { /* Cleanup cannot repair a prior failure. */ }
        return;
      }
      await fence(started ? () => input.fence.renewBeforeCredentialMutation() : () => input.fence.beginCredentialInteraction());
      try { await raw(() => input.page.fill(selector, value)); started = true; } catch { fail(); denied(); }
    },
    async click(selector) {
      await fence(() => input.fence.recordSubmitBarrier());
      try { await raw(() => input.page.click(selector)); } catch { fail(); denied(); }
    },
  };
  let outcome: BankAutoLoginOutcome | undefined;
  try { outcome = await input.strategy.autoLogin({ credential: input.credential, page }); } catch { fail(); }
  return blocked || input.signal.aborted || !outcome ? { status: "blocked" } : { status: "completed", outcome };
}
