export interface BankPortalConfig {
  // Foundation only: no production scraper caller yet; reserved metadata is non-authorizing.
  bankCode?: string;
  baseUrl: string;
  loginPathAllowlist: readonly string[];
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  mfaIndicatorSelector: string;
  incompatibleFlowSelector: string;
  dashboardPathIndicator?: string;
}

export interface LoginMutationPage {
  currentUrl(): string | Promise<string>;
  hasVisibleSelector(selector: string): boolean | Promise<boolean>;
}

export const LOGIN_MUTATION_GUARD_ERROR_SUMMARIES = {
  MALFORMED_PORTAL_URL: "Bank portal URL is malformed",
  UNAUTHORIZED_LOGIN_PAGE: "Bank login page is not authorized for credential mutation",
  INCOMPATIBLE_FLOW: "Bank portal requires admin action before credential submission",
  PROTECTED_FLOW: "Bank portal requires admin action before credential submission",
  MISSING_REQUIRED_LOGIN_CONTROL: "Bank login page is missing required login controls",
  PORTAL_STATE_UNAVAILABLE: "Bank portal state could not be verified",
} as const;

export type LoginMutationGuardSafeSummary =
  (typeof LOGIN_MUTATION_GUARD_ERROR_SUMMARIES)[keyof typeof LOGIN_MUTATION_GUARD_ERROR_SUMMARIES];

export type LoginMutationGuardReason =
  | "malformed_url"
  | "unauthorized_login_page"
  | "incompatible_flow"
  | "protected_flow"
  | "missing_required_login_control"
  | "portal_state_unavailable";

export class LoginMutationGuardError extends Error {
  readonly outcome = "needs_admin_action" as const;

  constructor(
    readonly reason: LoginMutationGuardReason,
    readonly safeSummary: LoginMutationGuardSafeSummary,
  ) {
    super(safeSummary);
    this.name = "LoginMutationGuardError";
  }
}

export class LoginMutationGuard {
  private readonly allowedOrigin: string;
  private readonly allowedLoginPaths: ReadonlySet<string>;

  constructor(private readonly config: BankPortalConfig) {
    const baseUrl = parseSafeUrl(config.baseUrl);
    if (!baseUrl || baseUrl.protocol !== "https:" || hasUserInfo(baseUrl)) {
      throw new LoginMutationGuardError(
        "malformed_url",
        LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MALFORMED_PORTAL_URL,
      );
    }

    const requiredSelectors = [config.usernameSelector, config.passwordSelector, config.submitSelector, config.mfaIndicatorSelector, config.incompatibleFlowSelector];
    if (!requiredSelectors.every(hasNonBlankString)) {
      throw createPortalStateUnavailableError();
    }

    const loginPathAllowlist = config.loginPathAllowlist;
    if (!Array.isArray(loginPathAllowlist) || loginPathAllowlist.length === 0 || !loginPathAllowlist.every(hasNonBlankString)) throw createPortalStateUnavailableError();
    this.allowedOrigin = baseUrl.origin;
    this.allowedLoginPaths = new Set(loginPathAllowlist.map(normalizeAllowedPath));
  }

  private async assertAuthorizedLoginUrl(page: LoginMutationPage): Promise<void> {
    const currentUrl = parseSafeUrl(await this.currentUrl(page));
    if (!currentUrl) {
      throw new LoginMutationGuardError(
        "malformed_url",
        LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MALFORMED_PORTAL_URL,
      );
    }

    if (
      currentUrl.protocol !== "https:" ||
      currentUrl.origin !== this.allowedOrigin ||
      hasUserInfo(currentUrl) ||
      !this.allowedLoginPaths.has(currentUrl.pathname)
    ) {
      throw new LoginMutationGuardError(
        "unauthorized_login_page",
        LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
      );
    }
  }

  /**
   * The sole authorization boundary for credential mutations. The URL is read
   * last so a redirect during any asynchronous selector check cannot reach a
   * fill or submit operation.
   */
  async assertMutationAuthorized(page: LoginMutationPage): Promise<void> {
    await this.assertRequiredControls(page, [this.config.usernameSelector, this.config.passwordSelector, this.config.submitSelector]);
    await this.assertNoProtectedOrIncompatibleState(page);
    await this.assertAuthorizedLoginUrl(page);
  }

  /**
   * Guard-owned protected/incompatible state check for both pre-mutation and
   * post-submit observations. Callers must not duplicate this policy.
   */
  async assertNoProtectedOrIncompatibleState(page: LoginMutationPage): Promise<void> {
    const [hasMfaIndicator, hasIncompatibleFlow] = await Promise.all([
      this.hasVisibleSelector(page, this.config.mfaIndicatorSelector),
      this.hasVisibleSelector(page, this.config.incompatibleFlowSelector),
    ]);

    if (hasMfaIndicator) {
      throw new LoginMutationGuardError(
        "protected_flow",
        LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PROTECTED_FLOW,
      );
    }

    if (hasIncompatibleFlow) {
      throw new LoginMutationGuardError(
        "incompatible_flow",
        LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.INCOMPATIBLE_FLOW,
      );
    }
  }

  private async assertRequiredControls(page: LoginMutationPage, selectors: readonly string[]): Promise<void> {
    for (const selector of selectors) {
      if (await this.hasVisibleSelector(page, selector)) continue;

      throw new LoginMutationGuardError(
        "missing_required_login_control",
        LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MISSING_REQUIRED_LOGIN_CONTROL,
      );
    }
  }

  private async currentUrl(page: LoginMutationPage): Promise<string> {
    try {
      return await page.currentUrl();
    } catch {
      throw createPortalStateUnavailableError();
    }
  }

  private async hasVisibleSelector(page: LoginMutationPage, selector: string): Promise<boolean> {
    try {
      return await page.hasVisibleSelector(selector);
    } catch {
      throw createPortalStateUnavailableError();
    }
  }
}

function createPortalStateUnavailableError(): LoginMutationGuardError {
  return new LoginMutationGuardError("portal_state_unavailable", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE);
}

function parseSafeUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function hasUserInfo(url: URL): boolean { return url.username.length > 0 || url.password.length > 0; }
function hasNonBlankString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function normalizeAllowedPath(path: string): string { return path.startsWith("/") ? path : `/${path}`; }
