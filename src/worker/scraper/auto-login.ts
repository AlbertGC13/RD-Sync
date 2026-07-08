import { LOGIN_MUTATION_GUARD_ERROR_SUMMARIES, LoginMutationGuard, LoginMutationGuardError, type BankPortalConfig, type LoginMutationPage } from "./login-mutation-guard";
import { assertCdpLoopback, getSafeCdpErrorSummary } from "./browser-runtime";
import type { AutoLoginLock } from "../../modules/bank-auto-login-lock";

export interface BankAutoLoginCredential {
  bankCode: string;
  username: string;
  password: string;
}

export interface BankAutoLoginPage extends LoginMutationPage {
  fill(selector: string, value: string): void | Promise<void>;
  click(selector: string): void | Promise<void>;
}

export type BankAutoLoginAdminActionReason =
  | "unsupported_bank"
  | "credential_bank_mismatch"
  | "incompatible_flow"
  | "protected_flow"
  | "missing_required_login_control"
  | "portal_state_unavailable"
  | "malformed_url"
  | "unauthorized_login_page"
  | "unknown_post_submit_state"
  | "browser_unavailable";

export type BankAutoLoginOutcome =
  | { status: "succeeded" }
  | { status: "needs_admin_action"; reason: BankAutoLoginAdminActionReason; safeSummary: string };

export interface BankAutoLoginStrategy {
  readonly bankCode: string;
  autoLogin(context: { credential: BankAutoLoginCredential; page: BankAutoLoginPage }): Promise<BankAutoLoginOutcome>;
}

export type ScrapeTimeAutoLoginOutcome =
  | BankAutoLoginOutcome
  | { status: "manual_required"; reason: "lock_busy" | "lock_unavailable"; safeSummary: string }
  | { status: "throttled"; safeSummary: string };

export interface ScrapeTimeAutoLoginTriggerContext {
  bankCode: string;
  expiredEventId: string;
  adapter: { readonly bankCode: string; createAutoLoginStrategy(): BankAutoLoginStrategy };
  credential: BankAutoLoginCredential;
  cdpUrl: string;
  lock: Pick<AutoLoginLock, "acquire" | "release">;
  ensureBrowser(cdpUrl: string): Promise<{ status: "ready"; page: BankAutoLoginPage } | { status: "throttled" }>;
  recordLockReleaseFailure?(metadata: { bankCode: string; expiredEventId: string }): void | Promise<void>;
}

const SAFE_ADMIN_ACTION_SUMMARY = "Bank auto-login requires admin action";
const SAFE_BROWSER_THROTTLED_SUMMARY = "Bank browser capacity is temporarily unavailable";
const SAFE_MANUAL_REQUIRED_SUMMARY = "Manual scrape required before retrying bank auto-login";

export async function executeScrapeTimeAutoLoginTrigger(context: ScrapeTimeAutoLoginTriggerContext): Promise<ScrapeTimeAutoLoginOutcome> {
  if (context.adapter.bankCode !== context.bankCode) return needsAdminAction("unsupported_bank");
  if (context.adapter.bankCode !== context.credential.bankCode) return needsAdminAction("credential_bank_mismatch");

  const cdpUrl = context.cdpUrl;
  try {
    assertCdpLoopback(cdpUrl);
  } catch (error) {
    return needsAdminAction("browser_unavailable", getSafeCdpErrorSummary(error));
  }

  let acquired: Awaited<ReturnType<ScrapeTimeAutoLoginTriggerContext["lock"]["acquire"]>>;
  try {
    acquired = await context.lock.acquire(context.bankCode, context.expiredEventId);
  } catch {
    return manualRequired("lock_unavailable");
  }
  if (!acquired) return manualRequired("lock_busy");

  try {
    return await runOwnedAutoLogin(context, cdpUrl);
  } finally {
    await releaseOwnedLock(context, acquired.leaseToken);
  }
}

async function releaseOwnedLock(context: ScrapeTimeAutoLoginTriggerContext, leaseToken: string): Promise<void> {
  try {
    const released = await context.lock.release(context.bankCode, context.expiredEventId, leaseToken);
    if (!released) await recordLockReleaseFailure(context);
  } catch {
    // Lock TTL bounds eventual cleanup; do not let infrastructure details leak past the safe outcome.
    await recordLockReleaseFailure(context);
  }
}

async function recordLockReleaseFailure(context: ScrapeTimeAutoLoginTriggerContext): Promise<void> {
  try {
    await context.recordLockReleaseFailure?.({ bankCode: context.bankCode, expiredEventId: context.expiredEventId });
  } catch {
    // Observability failures must not change the safe auto-login outcome.
  }
}

async function runOwnedAutoLogin(context: ScrapeTimeAutoLoginTriggerContext, cdpUrl: string): Promise<ScrapeTimeAutoLoginOutcome> {
  let browser: { status: "ready"; page: BankAutoLoginPage } | { status: "throttled" };

  try {
    browser = await context.ensureBrowser(cdpUrl);
  } catch {
    return needsAdminAction("browser_unavailable");
  }

  if (browser.status === "throttled") return { status: "throttled", safeSummary: SAFE_BROWSER_THROTTLED_SUMMARY };

  try {
    return await context.adapter.createAutoLoginStrategy().autoLogin({ credential: context.credential, page: browser.page });
  } catch {
    return needsAdminAction("portal_state_unavailable");
  }
}

function manualRequired(reason: "lock_busy" | "lock_unavailable"): ScrapeTimeAutoLoginOutcome {
  return { status: "manual_required", reason, safeSummary: SAFE_MANUAL_REQUIRED_SUMMARY };
}

export function createBankAutoLoginStrategy(
  portalConfig: BankPortalConfig,
  options: { supportedBankCodes?: readonly string[] } = {},
): BankAutoLoginStrategy {
  const bankCode = portalConfig.bankCode ?? "";
  const supportedBankCodes = new Set(options.supportedBankCodes ?? [bankCode]);

  return {
    bankCode,
    async autoLogin({ credential, page }) {
      if (!bankCode || !supportedBankCodes.has(bankCode)) return needsAdminAction("unsupported_bank");
      if (credential.bankCode !== bankCode) return needsAdminAction("credential_bank_mismatch");
      if (!hasNonBlankString(portalConfig.dashboardPathIndicator)) return needsAdminAction("portal_state_unavailable");

      const guardResult = createGuard(portalConfig);
      if (guardResult.outcome) return guardResult.outcome;
      const { guard } = guardResult;

      const beforeUsernameFill = await runGuard(() => guard.beforeFill(page));
      if (beforeUsernameFill) return beforeUsernameFill;
      const usernameFill = await runBrowserMutation(() => page.fill(portalConfig.usernameSelector, credential.username));
      if (usernameFill) return usernameFill;

      const beforePasswordFill = await runGuard(() => guard.beforeFill(page));
      if (beforePasswordFill) return beforePasswordFill;
      const passwordFill = await runBrowserMutation(() => page.fill(portalConfig.passwordSelector, credential.password));
      if (passwordFill) return passwordFill;

      const beforeSubmit = await runGuard(() => guard.beforeSubmit(page));
      if (beforeSubmit) return beforeSubmit;

      const submit = await runBrowserMutation(() => page.click(portalConfig.submitSelector));
      if (submit) return submit;
      return detectPostSubmitOutcome(page, portalConfig);
    },
  };
}

type GuardResult = { guard: LoginMutationGuard; outcome?: never } | { guard?: never; outcome: BankAutoLoginOutcome };

function createGuard(portalConfig: BankPortalConfig): GuardResult {
  try {
    return { guard: new LoginMutationGuard(portalConfig) };
  } catch (error) {
    if (error instanceof LoginMutationGuardError) return { outcome: needsAdminAction(error.reason, error.safeSummary) };
    return { outcome: needsAdminAction("portal_state_unavailable") };
  }
}

async function detectPostSubmitOutcome(page: BankAutoLoginPage, config: BankPortalConfig): Promise<BankAutoLoginOutcome> {
  const guardedState = await runGuard(async () => {
    if (await page.hasVisibleSelector(config.mfaIndicatorSelector)) {
      throw new LoginMutationGuardError("protected_flow", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PROTECTED_FLOW);
    }
    if (await page.hasVisibleSelector(config.incompatibleFlowSelector)) {
      throw new LoginMutationGuardError("incompatible_flow", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.INCOMPATIBLE_FLOW);
    }
  });
  if (guardedState) return guardedState;

  try {
    const baseUrl = new URL(config.baseUrl);
    const currentUrl = new URL(await page.currentUrl());
    if (
      baseUrl.protocol === "https:" &&
      currentUrl.protocol === "https:" &&
      currentUrl.origin === baseUrl.origin &&
      !hasUserInfo(baseUrl) &&
      !hasUserInfo(currentUrl) &&
      config.dashboardPathIndicator &&
      hasDashboardPathBoundary(currentUrl.pathname, config.dashboardPathIndicator)
    ) {
      return { status: "succeeded" };
    }
  } catch {
    return needsAdminAction("portal_state_unavailable");
  }

  return needsAdminAction("unknown_post_submit_state");
}

async function runBrowserMutation(operation: () => void | Promise<void>): Promise<BankAutoLoginOutcome | null> {
  try {
    await operation();
    return null;
  } catch {
    return needsAdminAction("portal_state_unavailable");
  }
}

async function runGuard(operation: () => Promise<void>): Promise<BankAutoLoginOutcome | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof LoginMutationGuardError) {
      return needsAdminAction(error.reason, error.safeSummary);
    }
    return needsAdminAction("portal_state_unavailable");
  }
}

function needsAdminAction(reason: BankAutoLoginAdminActionReason, safeSummary = SAFE_ADMIN_ACTION_SUMMARY): BankAutoLoginOutcome {
  return { status: "needs_admin_action", reason, safeSummary };
}

function hasNonBlankString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hasDashboardPathBoundary(pathname: string, dashboardPathIndicator: string): boolean { return pathname === dashboardPathIndicator || pathname.startsWith(`${dashboardPathIndicator}/`); }
function hasUserInfo(url: URL): boolean { return url.username.length > 0 || url.password.length > 0; }
