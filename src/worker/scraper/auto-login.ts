import { LOGIN_MUTATION_GUARD_ERROR_SUMMARIES, LoginMutationGuard, LoginMutationGuardError, type BankPortalConfig, type LoginMutationPage } from "./login-mutation-guard";

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
  | "unknown_post_submit_state";

export type BankAutoLoginOutcome =
  | { status: "succeeded" }
  | { status: "needs_admin_action"; reason: BankAutoLoginAdminActionReason; safeSummary: string };

export interface BankAutoLoginStrategy {
  readonly bankCode: string;
  autoLogin(context: { credential: BankAutoLoginCredential; page: BankAutoLoginPage }): Promise<BankAutoLoginOutcome>;
}

const SAFE_ADMIN_ACTION_SUMMARY = "Bank auto-login requires admin action";

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
      currentUrl.pathname.startsWith(config.dashboardPathIndicator)
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
function hasUserInfo(url: URL): boolean { return url.username.length > 0 || url.password.length > 0; }
